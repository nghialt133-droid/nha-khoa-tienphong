/* ===================== State ===================== */
let pages = [];
let tags = [];
let templateCategories = [];
let conversations = [];
let activePageRowId = 'all';
let activeTagId = 'all';
let searchTerm = '';
let activeConvId = null;
let lastMsgCount = 0;
let pollTimer = null;
let pendingAttachment = null; // { url, type } once uploaded, before send
let prevUnreadByConv = {}; // conversation id -> unread_count, used to detect new messages for notifications
let unreadTitleCount = 0;

const SWATCHES = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
let selectedSwatch = SWATCHES[0];

/* ===================== Helpers ===================== */
async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
  e.innerHTML = html;
  return e;
};

/* ===================== Staff name (shared login, multi-person) ===================== */
function getStaffName() { return localStorage.getItem('dental_inbox_staff_name') || ''; }
function setStaffName(name) {
  localStorage.setItem('dental_inbox_staff_name', name);
  $('#staffNameBtn').textContent = `🧑‍⚕️ Bạn: ${name}`;
}
function promptStaffName(force) {
  const current = getStaffName();
  if (current && !force) return;
  const name = prompt('Tên của bạn là gì? (để đồng nghiệp biết ai đã trả lời khách)', current || '');
  if (name && name.trim()) setStaffName(name.trim());
}
$('#staffNameBtn').addEventListener('click', () => promptStaffName(true));

/* ===================== Notifications ===================== */
function updateTitleBadge() {
  document.title = unreadTitleCount > 0 ? `(${unreadTitleCount}) Hộp thư hợp nhất` : 'Hộp thư hợp nhất – Nha Khoa';
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { unreadTitleCount = 0; updateTitleBadge(); }
});
$('#notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return alert('Trình duyệt này không hỗ trợ thông báo trên màn hình.');
  const perm = await Notification.requestPermission();
  $('#notifyBtn').textContent = perm === 'granted' ? '🔔 Đã bật thông báo' : '🔔 Bật thông báo';
  if (perm === 'granted') new Notification('Đã bật thông báo', { body: 'Bạn sẽ được báo khi có tin nhắn mới.' });
});
function notifyNewMessages(namesList) {
  const sound = $('#notifySound');
  if (sound) sound.play().catch(() => {});
  if (document.hidden) { unreadTitleCount += namesList.length; updateTitleBadge(); }
  if ('Notification' in window && Notification.permission === 'granted') {
    const body = namesList.length === 1 ? `Tin nhắn mới từ ${namesList[0]}` : `Tin nhắn mới từ: ${namesList.slice(0, 3).join(', ')}${namesList.length > 3 ? '…' : ''}`;
    new Notification('Hộp thư hợp nhất', { body, icon: '/icon-192.png' });
  }
}

/* ===================== Auth ===================== */
async function checkAuth() {
  const { loggedIn } = await api('/api/auth/me');
  if (loggedIn) showApp(); else showLogin();
}

function showLogin() {
  $('#appRoot').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
  if (pollTimer) clearInterval(pollTimer);
}

async function showApp() {
  $('#loginScreen').classList.add('hidden');
  $('#appRoot').classList.remove('hidden');
  const savedName = getStaffName();
  if (savedName) $('#staffNameBtn').textContent = `🧑‍⚕️ Bạn: ${savedName}`;
  else setTimeout(() => promptStaffName(false), 300);
  await loadAll();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollTick, 8000);
}

$('#loginBtn').addEventListener('click', doLogin);
$('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const password = $('#loginPassword').value;
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#loginError').textContent = '';
    $('#loginPassword').value = '';
    showApp();
  } catch (e) {
    $('#loginError').textContent = e.message;
  }
}
$('#logoutBtn').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); showLogin(); });

/* ===================== Load everything ===================== */
async function loadAll() {
  [pages, tags, templateCategories] = await Promise.all([
    api('/api/pages'),
    api('/api/tags'),
    api('/api/templates'),
  ]);
  await loadStats();
  await loadConversations();
  captureUnreadBaseline();
  renderRail();
  renderTemplateSidebar();
  if (conversations.length && !activeConvId) selectConversation(conversations[0].id);
}

async function loadStats() {
  const s = await api('/api/stats');
  $('#statTotal').textContent = s.total;
  $('#statUnread').textContent = s.unread;
  $('#statBooked').textContent = s.booked;
}

async function loadConversations() {
  const params = new URLSearchParams();
  if (activePageRowId !== 'all') params.set('page_row_id', activePageRowId);
  if (activeTagId !== 'all') params.set('tag_id', activeTagId);
  if (searchTerm) params.set('search', searchTerm);
  conversations = await api(`/api/conversations?${params.toString()}`);
  renderConvList();
}

function captureUnreadBaseline() {
  prevUnreadByConv = Object.fromEntries(conversations.map((c) => [c.id, c.unread_count]));
}

async function pollTick() {
  try {
    await loadStats();
    const before = prevUnreadByConv;
    await loadConversations();
    // Detect conversations whose unread count just went up -> new inbound message(s)
    const newlyMessaged = conversations.filter((c) => (before[c.id] ?? 0) < c.unread_count);
    if (newlyMessaged.length > 0 && Object.keys(before).length > 0) {
      notifyNewMessages(newlyMessaged.map((c) => c.customer_name));
    }
    captureUnreadBaseline();

    if (activeConvId) {
      const conv = await api(`/api/conversations/${activeConvId}`);
      if (conv.messages.length !== lastMsgCount) {
        const draft = $('#composerInput') ? $('#composerInput').value : '';
        renderThread(conv);
        if ($('#composerInput')) $('#composerInput').value = draft;
      }
    }
  } catch (e) { /* silent */ }
}

/* ===================== Rail (fanpages + tags) ===================== */
function renderRail() {
  const rail = $('#channelRail');
  rail.innerHTML = '';
  rail.appendChild(el('div', { class: 'rail-title' }, 'Fanpage'));

  const allItem = el('div', { class: `rail-item ${activePageRowId === 'all' ? 'active' : ''}` },
    `<span class="rail-dot" style="background:var(--fb)"></span> Tất cả <span class="rail-count">${pages.length}</span>`);
  allItem.addEventListener('click', () => { activePageRowId = 'all'; renderRail(); loadConversations(); });
  rail.appendChild(allItem);

  if (pages.length === 0) {
    rail.appendChild(el('div', { class: 'rail-empty' }, 'Chưa kết nối fanpage nào. Bấm ⚙ Cài đặt để thêm.'));
  }
  pages.forEach((p) => {
    const marker = p.channel === 'website' ? '🌐' : `<span class="rail-dot" style="background:var(--fb)"></span>`;
    const item = el('div', { class: `rail-item ${String(activePageRowId) === String(p.id) ? 'active' : ''}` },
      `${marker} ${escapeHtml(p.name)}`);
    item.addEventListener('click', () => { activePageRowId = p.id; renderRail(); loadConversations(); });
    rail.appendChild(item);
  });

  rail.appendChild(el('div', { class: 'rail-title', style: 'margin-top:14px;' }, 'Tag'));
  const allTagItem = el('div', { class: `rail-item ${activeTagId === 'all' ? 'active' : ''}` }, `Tất cả`);
  allTagItem.addEventListener('click', () => { activeTagId = 'all'; renderRail(); loadConversations(); });
  rail.appendChild(allTagItem);
  tags.forEach((t) => {
    const item = el('div', { class: `rail-item ${String(activeTagId) === String(t.id) ? 'active' : ''}` },
      `<span class="rail-dot" style="background:${t.color}"></span> ${escapeHtml(t.name)}`);
    item.addEventListener('click', () => { activeTagId = t.id; renderRail(); loadConversations(); });
    rail.appendChild(item);
  });
}

/* ===================== Conversation list ===================== */
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Escape text then turn http(s):// URLs into clickable links — safe against injection since escaping runs first. */
function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function renderAttachment(m) {
  if (!m.attachment_url) return '';
  if (m.attachment_type === 'video') return `<video src="${escapeHtml(m.attachment_url)}" controls class="msg-media"></video>`;
  if (m.attachment_type === 'image') return `<img src="${escapeHtml(m.attachment_url)}" class="msg-media" onclick="window.open('${escapeHtml(m.attachment_url)}','_blank')">`;
  return `<a href="${escapeHtml(m.attachment_url)}" target="_blank" rel="noopener noreferrer" class="msg-file-link">📎 Xem file đính kèm</a>`;
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase();
}

/** Avatar circle: real Facebook profile photo as a CSS background if we have one (silently falls
 * back to a blank colored circle if the image URL fails to load — never an ugly broken-image icon),
 * otherwise the customer's initials as text. */
function avatarAttrs(name, avatarUrl) {
  const style = avatarUrl ? ` style="background-image:url('${escapeHtml(avatarUrl)}');background-size:cover;background-position:center;"` : '';
  const text = avatarUrl ? '' : initials(name);
  return { style, text };
}

function renderConvList() {
  const scroll = $('#convScroll');
  if (conversations.length === 0) {
    scroll.innerHTML = '';
    scroll.appendChild(el('div', { class: 'empty-state' }, 'Chưa có hội thoại nào khớp bộ lọc.'));
    return;
  }
  scroll.innerHTML = '';
  conversations.forEach((c) => {
    const item = el('div', { class: `conv-item ${c.id === activeConvId ? 'active' : ''}`, 'data-id': c.id });
    const av = avatarAttrs(c.customer_name, c.customer_avatar_url);
    item.innerHTML = `
      <div class="avatar"${av.style}>${av.text}</div>
      <div class="conv-body">
        <div class="conv-top">
          <span class="conv-name">${c.page && c.page.channel === 'website' ? '🌐 ' : ''}${escapeHtml(c.customer_name)}</span>
          <span class="conv-time">${formatTime(c.last_message_at)}</span>
        </div>
        <div class="conv-preview">${escapeHtml(c.last_message_preview)}</div>
        <div class="conv-meta">
          ${c.tags.map((t) => `<span class="tag-chip"><span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}</span>`).join('')}
          ${c.unread_count > 0 ? `<span class="unread-count">${c.unread_count}</span>` : ''}
        </div>
      </div>`;
    item.addEventListener('click', () => selectConversation(c.id, true));
    scroll.appendChild(item);
  });
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('vi-VN');
}

/* ===================== Thread ===================== */
async function selectConversation(id, fromUserClick) {
  activeConvId = id;
  renderConvList();
  const conv = await api(`/api/conversations/${id}`);
  await api(`/api/conversations/${id}/read`, { method: 'POST' });
  await loadStats();
  await loadConversations();
  renderThread(conv);
  renderCustomerCard(conv);
  // Only jump to the thread pane on phones when the user actually tapped a conversation —
  // not on the automatic "open first conversation" that happens right after login.
  if (fromUserClick) $('#mainArea').classList.add('mobile-show-thread');
}

/* ===================== Mobile nav ===================== */
$('#hamburgerBtn').addEventListener('click', () => {
  $('#mainArea').classList.toggle('mobile-show-rail');
});

function renderThread(conv) {
  lastMsgCount = conv.messages.length;
  pendingAttachment = null;
  const isWebsite = !!(conv.page && conv.page.channel === 'website');
  const threadAv = avatarAttrs(conv.customer_name, conv.customer_avatar_url);
  const panel = $('#threadPanel');
  panel.innerHTML = `
    <div class="thread-header">
      <button class="icon-btn mobile-only back-btn" id="backToListBtn">← Danh sách</button>
      <div class="avatar"${threadAv.style}>${threadAv.text}</div>
      <div class="thread-header-info">
        <h2>${escapeHtml(conv.customer_name)}</h2>
        <div class="sub">${isWebsite ? '🌐 Đặt lịch từ Website' : escapeHtml(conv.page ? conv.page.name : '')}</div>
      </div>
      <div class="thread-tags" id="threadTags"></div>
      <button class="icon-btn mobile-only" id="infoToggleBtn">ℹ</button>
    </div>
    <div class="msgs" id="msgsArea">
      ${conv.messages.map((m) => `
        <div class="msg-row ${m.direction}">
          <div class="msg-col">
            <div class="bubble">
              ${renderAttachment(m)}
              ${m.text ? `<div class="msg-text${m.attachment_url ? ' msg-caption' : ''}">${linkify(m.text)}</div>` : ''}
            </div>
            <div class="msg-time">${m.direction === 'out' && m.staff_name ? `${escapeHtml(m.staff_name)} · ` : ''}${formatTime(m.created_at)}</div>
          </div>
        </div>`).join('')}
    </div>
    ${isWebsite ? `
    <div class="website-banner">
      <div>🌐 Đây là lượt <b>đặt lịch từ Website</b> — không thể trả lời qua app này (không đi qua Facebook).</div>
      ${conv.customer_phone
        ? `<a class="tel-btn" href="tel:${escapeHtml(conv.customer_phone)}">📞 Gọi ${escapeHtml(conv.customer_phone)}</a>`
        : `<span style="color:var(--text-muted);">Khách không để lại số điện thoại.</span>`}
    </div>` : `
    <div class="composer">
      <div id="attachPreviewRow"></div>
      <div class="quick-chip-row" id="quickChipRow"></div>
      <div class="composer-row">
        <input type="file" id="fileInput" accept="image/*,video/*" class="hidden">
        <button class="icon-btn attach-btn" id="attachBtn" title="Gửi ảnh / video">📎</button>
        <textarea id="composerInput" placeholder="Nhập tin nhắn trả lời khách..."></textarea>
        <button class="send-btn" id="sendBtn">Gửi</button>
      </div>
      <div class="composer-note">Chỉ gửi được tin tự do trong vòng 24 giờ kể từ tin nhắn cuối của khách (chính sách Facebook). Ảnh/video tối đa 20MB.</div>
    </div>`}`;
  renderThreadTags(conv);
  if (!isWebsite) {
    renderQuickChips();
    $('#sendBtn').addEventListener('click', () => sendMessage(conv.id));
    $('#composerInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(conv.id); } });
    $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', (e) => handleFileSelected(e, conv.id));
  }
  const backBtn = $('#backToListBtn');
  if (backBtn) backBtn.addEventListener('click', showListOnMobile);
  const infoBtn = $('#infoToggleBtn');
  if (infoBtn) infoBtn.addEventListener('click', toggleSidePanelMobile);
  scrollMsgsToBottom();
}

/* ===================== Attachments (ảnh/video) ===================== */
async function handleFileSelected(e, convId) {
  const file = e.target.files[0];
  if (!file) return;
  const row = $('#attachPreviewRow');
  row.innerHTML = `<div class="attach-uploading">Đang tải lên...</div>`;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Tải lên thất bại');
    pendingAttachment = { url: data.url, type: data.type };
    row.innerHTML = `
      <div class="attach-preview">
        ${data.type === 'video' ? `<video src="${data.url}" class="attach-thumb"></video>` : `<img src="${data.url}" class="attach-thumb">`}
        <span>Đã đính kèm ${data.type === 'video' ? 'video' : 'ảnh'} — sẽ gửi kèm tin nhắn</span>
        <span class="attach-remove" id="attachRemoveBtn">✕ Bỏ</span>
      </div>`;
    $('#attachRemoveBtn').addEventListener('click', () => { pendingAttachment = null; row.innerHTML = ''; });
  } catch (err) {
    row.innerHTML = `<div class="attach-uploading" style="color:#d03b3b;">${escapeHtml(err.message)}</div>`;
    pendingAttachment = null;
  }
  e.target.value = '';
}

function showListOnMobile() { $('#mainArea').classList.remove('mobile-show-thread'); }
function toggleSidePanelMobile() { $('#sidePanel').classList.toggle('mobile-show'); }

function scrollMsgsToBottom() { const a = $('#msgsArea'); if (a) a.scrollTop = a.scrollHeight; }

function renderThreadTags(conv) {
  const wrap = $('#threadTags');
  wrap.innerHTML = '';
  conv.tags.forEach((t) => {
    const chip = el('span', { class: 'tag-chip removable' }, `<span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}<span class="x">✕</span>`);
    chip.addEventListener('click', async () => {
      await api(`/api/conversations/${conv.id}/tags/${t.id}`, { method: 'DELETE' });
      const fresh = await api(`/api/conversations/${conv.id}`);
      renderThread(fresh); renderCustomerCard(fresh); loadConversations(); loadStats();
    });
    wrap.appendChild(chip);
  });
  const addWrap = el('span', { class: 'add-tag-wrap' });
  const addBtn = el('span', { class: 'add-tag-btn' }, '+ tag');
  addWrap.appendChild(addBtn);
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    let menu = addWrap.querySelector('.add-tag-menu');
    if (menu) { menu.remove(); return; }
    menu = el('div', { class: 'add-tag-menu' });
    const available = tags.filter((t) => !conv.tags.some((ct) => ct.id === t.id));
    if (available.length === 0) menu.innerHTML = '<div class="opt">Đã gắn hết tag</div>';
    available.forEach((t) => {
      const opt = el('div', { class: 'opt' }, `<span class="rail-dot" style="background:${t.color}"></span>${escapeHtml(t.name)}`);
      opt.addEventListener('click', async () => {
        await api(`/api/conversations/${conv.id}/tags`, { method: 'POST', body: JSON.stringify({ tag_id: t.id }) });
        const fresh = await api(`/api/conversations/${conv.id}`);
        renderThread(fresh); renderCustomerCard(fresh); loadConversations(); loadStats();
      });
      menu.appendChild(opt);
    });
    addWrap.appendChild(menu);
  });
  wrap.appendChild(addWrap);
}

function renderQuickChips() {
  const flat = templateCategories.flatMap((c) => c.items);
  const quick = flat.slice(0, 4);
  const row = $('#quickChipRow');
  row.innerHTML = '';
  quick.forEach((t) => {
    const chip = el('span', { class: 'quick-chip' }, escapeHtml(t.label));
    chip.addEventListener('click', () => insertTemplate(t.text));
    row.appendChild(chip);
  });
}

function insertTemplate(text) {
  const input = $('#composerInput');
  if (!input) return;
  input.value = text;
  input.focus();
}

async function sendMessage(convId) {
  const input = $('#composerInput');
  const text = input.value.trim();
  if (!text && !pendingAttachment) return;
  const btn = $('#sendBtn');
  btn.disabled = true;
  try {
    await api(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        attachment_url: pendingAttachment ? pendingAttachment.url : undefined,
        attachment_type: pendingAttachment ? pendingAttachment.type : undefined,
        staff_name: getStaffName() || undefined,
      }),
    });
    input.value = '';
    pendingAttachment = null;
    const fresh = await api(`/api/conversations/${convId}`);
    renderThread(fresh);
    loadConversations();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ===================== Customer card + template sidebar ===================== */
function renderCustomerCard(conv) {
  const isWebsite = !!(conv.page && conv.page.channel === 'website');
  $('#customerCard').innerHTML = `
    <div class="cname">${escapeHtml(conv.customer_name)}</div>
    <div class="crow"><span>Nguồn</span><span>${isWebsite ? '🌐 Website' : escapeHtml(conv.page ? conv.page.name : '')}</span></div>
    ${conv.customer_phone ? `<div class="crow"><span>Điện thoại</span><span><a href="tel:${escapeHtml(conv.customer_phone)}">${escapeHtml(conv.customer_phone)}</a></span></div>` : ''}
    ${!isWebsite ? `<div class="crow"><span>PSID</span><span style="font-size:10px;">${escapeHtml(conv.customer_psid)}</span></div>` : ''}
  `;
}

function renderTemplateSidebar() {
  const wrap = $('#templateList');
  wrap.innerHTML = '';
  templateCategories.forEach((cat) => {
    wrap.appendChild(el('div', { class: 'template-cat-name' }, escapeHtml(cat.name)));
    cat.items.forEach((t) => {
      const item = el('div', { class: 'template-item' }, `<div class="tlabel">${escapeHtml(t.label)}</div><div class="ttext">${escapeHtml(t.text)}</div>`);
      item.addEventListener('click', () => insertTemplate(t.text));
      wrap.appendChild(item);
    });
  });
}

/* ===================== Search ===================== */
$('#searchInput').addEventListener('input', (e) => { searchTerm = e.target.value.trim(); loadConversations(); });

/* ===================== Settings overlay ===================== */
$('#settingsBtn').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', closeSettings);
function openSettings() { $('#settingsOverlay').classList.remove('hidden'); refreshSettings(); }
function closeSettings() { $('#settingsOverlay').classList.add('hidden'); }

async function refreshSettings() {
  const info = await api('/api/webhook-info');
  $('#webhookUrlBox').textContent = `Webhook URL: ${info.webhook_url}`;
  $('#verifyTokenBox').textContent = `Verify Token: ${info.verify_token}`;
  const webInfo = await api('/api/website-webhook-info');
  $('#websiteWebhookUrlBox').textContent = `Webhook URL: ${webInfo.webhook_url}`;
  renderPagesAdmin();
  renderTagsAdmin();
  renderTemplatesAdmin();
}

function renderPagesAdmin() {
  const wrap = $('#pagesList');
  wrap.innerHTML = '';
  pages.filter((p) => p.channel !== 'website').forEach((p) => {
    const row = el('div', { class: 'list-row' }, `<span class="grow"><b>${escapeHtml(p.name)}</b> — Page ID: ${escapeHtml(p.page_id)} — Token: ${escapeHtml(p.access_token_masked)}</span><span class="sync-hist" style="cursor:pointer;color:var(--fb);margin-right:10px;">🔄 Đồng bộ 30 ngày</span><span class="del">Xoá</span>`);
    row.querySelector('.sync-hist').addEventListener('click', async (e) => {
      const label = e.target;
      const original = label.textContent;
      label.textContent = 'Đang đồng bộ…';
      try {
        const result = await api(`/api/pages/${p.id}/sync-history`, { method: 'POST', body: JSON.stringify({ days: 30 }) });
        alert(`Đã đồng bộ ${result.conversations} hội thoại, ${result.messages_imported} tin nhắn từ 30 ngày qua.`);
        loadConversations();
      } catch (err) {
        alert('Đồng bộ thất bại: ' + err.message);
      } finally {
        label.textContent = original;
      }
    });
    row.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Xoá kết nối fanpage "${p.name}"?`)) return;
      await api(`/api/pages/${p.id}`, { method: 'DELETE' });
      pages = await api('/api/pages');
      renderPagesAdmin(); renderRail(); loadConversations();
    });
    wrap.appendChild(row);
  });
}
$('#addPageBtn').addEventListener('click', async () => {
  const name = $('#pgName').value.trim();
  const page_id = $('#pgId').value.trim();
  const access_token = $('#pgToken').value.trim();
  if (!name || !page_id || !access_token) return alert('Điền đủ Tên, Page ID và Access Token nhé.');
  try {
    await api('/api/pages', { method: 'POST', body: JSON.stringify({ name, page_id, access_token }) });
    $('#pgName').value = ''; $('#pgId').value = ''; $('#pgToken').value = '';
    pages = await api('/api/pages');
    renderPagesAdmin(); renderRail(); loadConversations();
  } catch (e) { alert(e.message); }
});

function renderTagsAdmin() {
  const wrap = $('#tagsList');
  wrap.innerHTML = '';
  tags.forEach((t) => {
    const row = el('div', { class: 'list-row' }, `<span class="rail-dot" style="background:${t.color}"></span><span class="grow">${escapeHtml(t.name)}</span><span class="del">Xoá</span>`);
    row.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Xoá tag "${t.name}"?`)) return;
      await api(`/api/tags/${t.id}`, { method: 'DELETE' });
      tags = await api('/api/tags');
      renderTagsAdmin(); renderRail(); loadConversations();
    });
    wrap.appendChild(row);
  });
  const sw = $('#tagSwatches');
  sw.innerHTML = '';
  SWATCHES.forEach((color) => {
    const s = el('span', { class: `swatch ${color === selectedSwatch ? 'selected' : ''}`, style: `background:${color}` });
    s.addEventListener('click', () => { selectedSwatch = color; renderTagsAdmin(); });
    sw.appendChild(s);
  });
}
$('#addTagBtn').addEventListener('click', async () => {
  const name = $('#tagName').value.trim();
  if (!name) return;
  try {
    await api('/api/tags', { method: 'POST', body: JSON.stringify({ name, color: selectedSwatch }) });
    $('#tagName').value = '';
    tags = await api('/api/tags');
    renderTagsAdmin(); renderRail(); loadConversations();
  } catch (e) { alert(e.message); }
});

function renderTemplatesAdmin() {
  const wrap = $('#templatesAdmin');
  wrap.innerHTML = '';
  templateCategories.forEach((cat) => {
    const block = el('div', { style: 'margin-bottom:14px;' });
    block.innerHTML = `<div class="list-row"><span class="grow"><b>${escapeHtml(cat.name)}</b></span><span class="del" data-cat="${cat.id}">Xoá nhóm</span></div>`;
    block.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Xoá nhóm "${cat.name}" và toàn bộ mẫu trong nhóm?`)) return;
      await api(`/api/template-categories/${cat.id}`, { method: 'DELETE' });
      templateCategories = await api('/api/templates');
      renderTemplatesAdmin(); renderTemplateSidebar();
    });
    cat.items.forEach((t) => {
      const row = el('div', { class: 'list-row', style: 'margin-left:14px;' },
        `<span class="grow">${escapeHtml(t.label)}</span><span class="del" data-act="edit" style="color:var(--fb);">Sửa</span><span class="del">Xoá</span>`);
      const [editBtn, delBtn] = row.querySelectorAll('.del');
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Xoá mẫu "${t.label}"?`)) return;
        await api(`/api/templates/${t.id}`, { method: 'DELETE' });
        templateCategories = await api('/api/templates');
        renderTemplatesAdmin(); renderTemplateSidebar();
      });
      editBtn.addEventListener('click', () => {
        row.innerHTML = '';
        const labelInput = el('input', { value: t.label, style: 'flex:1;min-width:100px;' });
        labelInput.value = t.label;
        const textInput = el('input', { value: t.text, style: 'flex:2;min-width:160px;' });
        textInput.value = t.text;
        const saveBtn = el('span', { class: 'del', style: 'color:var(--good);' }, 'Lưu');
        const cancelBtn = el('span', { class: 'del', style: 'color:var(--text-muted);' }, 'Huỷ');
        row.append(labelInput, textInput, saveBtn, cancelBtn);
        saveBtn.addEventListener('click', async () => {
          await api(`/api/templates/${t.id}`, { method: 'PUT', body: JSON.stringify({ label: labelInput.value.trim(), text: textInput.value.trim() }) });
          templateCategories = await api('/api/templates');
          renderTemplatesAdmin(); renderTemplateSidebar();
        });
        cancelBtn.addEventListener('click', () => { renderTemplatesAdmin(); });
      });
      block.appendChild(row);
    });
    const addRow = el('div', { class: 'field-row', style: 'margin-left:14px;' });
    addRow.innerHTML = `<input placeholder="Tên mẫu (vd: Giá tẩy trắng)" class="tplLabel"><input placeholder="Nội dung tin nhắn" class="tplText" style="flex:2;"><button class="tplAdd">+ Thêm</button>`;
    addRow.querySelector('.tplAdd').addEventListener('click', async () => {
      const label = addRow.querySelector('.tplLabel').value.trim();
      const text = addRow.querySelector('.tplText').value.trim();
      if (!label || !text) return;
      await api('/api/templates', { method: 'POST', body: JSON.stringify({ category_id: cat.id, label, text }) });
      templateCategories = await api('/api/templates');
      renderTemplatesAdmin(); renderTemplateSidebar();
    });
    block.appendChild(addRow);
    wrap.appendChild(block);
  });
}
$('#addCatBtn').addEventListener('click', async () => {
  const name = $('#newCatName').value.trim();
  if (!name) return;
  await api('/api/template-categories', { method: 'POST', body: JSON.stringify({ name }) });
  $('#newCatName').value = '';
  templateCategories = await api('/api/templates');
  renderTemplatesAdmin(); renderTemplateSidebar();
});

/* ===================== Init ===================== */
checkAuth();
