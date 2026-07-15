// routes/api.js — REST API used by the frontend dashboard
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { sendTextMessage, sendAttachment } = require('../facebook');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|webm))$/;
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB — Messenger's own attachment limit is ~25MB
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.test(file.mimetype)),
});

/* ================= UPLOAD (ảnh / video đính kèm) ================= */
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không nhận được file, hoặc định dạng không được hỗ trợ (chỉ ảnh jpg/png/gif/webp hoặc video mp4/mov/webm, tối đa 20MB).' });
  const host = req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const url = `${proto}://${host}/uploads/${req.file.filename}`;
  const type = req.file.mimetype.startsWith('video') ? 'video' : 'image';
  res.json({ url, type });
});

function maskToken(token) {
  if (!token) return '';
  return token.length <= 8 ? '••••••••' : `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function serializeConversation(conv) {
  const tags = db
    .prepare(
      `SELECT t.id, t.name, t.color FROM tags t
       JOIN conversation_tags ct ON ct.tag_id = t.id
       WHERE ct.conversation_id = ? ORDER BY t.sort_order`
    )
    .all(conv.id);
  const page = db.prepare('SELECT id, name, page_id FROM pages WHERE id = ?').get(conv.page_row_id);
  return { ...conv, tags, page };
}

/* ================= PAGES (fanpage connections) ================= */
router.get('/pages', (req, res) => {
  const pages = db.prepare('SELECT * FROM pages ORDER BY id').all();
  res.json(pages.map((p) => ({ ...p, access_token_masked: maskToken(p.access_token), access_token: undefined })));
});

router.post('/pages', (req, res) => {
  const { name, page_id, access_token } = req.body;
  if (!name || !page_id || !access_token) return res.status(400).json({ error: 'Thiếu name, page_id hoặc access_token' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM pages').get().n;
  if (count >= 5) return res.status(400).json({ error: 'Đã đạt giới hạn 5 fanpage trong bản này' });
  try {
    const info = db
      .prepare('INSERT INTO pages (name, page_id, access_token) VALUES (?, ?, ?)')
      .run(name, page_id, access_token);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Page ID này đã được kết nối rồi' : e.message });
  }
});

router.put('/pages/:id', (req, res) => {
  const { name, access_token, active } = req.body;
  const existing = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy fanpage' });
  db.prepare('UPDATE pages SET name = ?, access_token = ?, active = ? WHERE id = ?').run(
    name ?? existing.name,
    access_token ?? existing.access_token,
    active === undefined ? existing.active : (active ? 1 : 0),
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/pages/:id', (req, res) => {
  db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/webhook-info', (req, res) => {
  const host = req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  res.json({
    webhook_url: `${proto}://${host}/webhook`,
    verify_token: process.env.WEBHOOK_VERIFY_TOKEN || 'change_this_verify_token',
  });
});

/* ================= CONVERSATIONS ================= */
router.get('/conversations', (req, res) => {
  const { page_row_id, tag_id, search, status } = req.query;
  let sql = 'SELECT * FROM conversations WHERE 1=1';
  const params = [];
  if (page_row_id) { sql += ' AND page_row_id = ?'; params.push(page_row_id); }
  if (search) { sql += ' AND (customer_name LIKE ? OR last_message_preview LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  if (status === 'unread') sql += ' AND unread_count > 0';
  sql += ' ORDER BY last_message_at DESC LIMIT 300';
  let list = db.prepare(sql).all(...params).map(serializeConversation);
  if (tag_id) list = list.filter((c) => c.tags.some((t) => String(t.id) === String(tag_id)));
  res.json(list);
});

router.get('/conversations/:id', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Không tìm thấy hội thoại' });
  const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(conv.id);
  res.json({ ...serializeConversation(conv), messages });
});

router.post('/conversations/:id/read', (req, res) => {
  db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/conversations/:id/messages', async (req, res) => {
  const { text, attachment_url, attachment_type, staff_name } = req.body;
  const cleanText = (text || '').trim();
  if (!cleanText && !attachment_url) return res.status(400).json({ error: 'Tin nhắn trống' });
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Không tìm thấy hội thoại' });
  const page = db.prepare('SELECT * FROM pages WHERE id = ?').get(conv.page_row_id);
  if (!page) return res.status(400).json({ error: 'Fanpage của hội thoại này chưa được cấu hình' });

  try {
    if (attachment_url) {
      await sendAttachment(page.access_token, conv.customer_psid, attachment_url, attachment_type === 'video' ? 'video' : 'image');
      if (cleanText) await sendTextMessage(page.access_token, conv.customer_psid, cleanText);
    } else {
      await sendTextMessage(page.access_token, conv.customer_psid, cleanText);
    }
  } catch (e) {
    return res.status(502).json({
      error: `Gửi thất bại qua Facebook: ${e.message}. Lưu ý: chỉ gửi được tin tự do trong vòng 24h kể từ tin nhắn cuối của khách.`,
    });
  }

  db.prepare(
    `INSERT INTO messages (conversation_id, direction, text, staff_name, attachment_url, attachment_type) VALUES (?, 'out', ?, ?, ?, ?)`
  ).run(conv.id, cleanText, staff_name || null, attachment_url || null, attachment_url ? (attachment_type === 'video' ? 'video' : 'image') : null);

  const preview = cleanText || (attachment_type === 'video' ? '🎥 Đã gửi video' : attachment_url ? '📷 Đã gửi ảnh' : '');
  db.prepare(`UPDATE conversations SET last_message_preview = ?, last_message_at = datetime('now') WHERE id = ?`).run(
    preview.slice(0, 140),
    conv.id
  );
  res.json({ ok: true });
});

/* ================= TAGS ================= */
router.get('/tags', (req, res) => {
  res.json(db.prepare('SELECT * FROM tags ORDER BY sort_order, id').all());
});

router.post('/tags', (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Thiếu tên tag' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM tags').get().m;
  try {
    const info = db.prepare('INSERT INTO tags (name, color, sort_order) VALUES (?, ?, ?)').run(name, color || '#2a78d6', maxOrder + 1);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Tag này đã tồn tại' : e.message });
  }
});

router.delete('/tags/:id', (req, res) => {
  db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/conversations/:id/tags', (req, res) => {
  const { tag_id } = req.body;
  db.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)').run(req.params.id, tag_id);
  res.json({ ok: true });
});

router.delete('/conversations/:id/tags/:tagId', (req, res) => {
  db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?').run(req.params.id, req.params.tagId);
  res.json({ ok: true });
});

/* ================= TEMPLATES ================= */
router.get('/templates', (req, res) => {
  const categories = db.prepare('SELECT * FROM template_categories ORDER BY sort_order, id').all();
  const items = db.prepare('SELECT * FROM templates ORDER BY sort_order, id').all();
  res.json(categories.map((c) => ({ ...c, items: items.filter((i) => i.category_id === c.id) })));
});

router.post('/template-categories', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Thiếu tên nhóm' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM template_categories').get().m;
  const info = db.prepare('INSERT INTO template_categories (name, sort_order) VALUES (?, ?)').run(name, maxOrder + 1);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/template-categories/:id', (req, res) => {
  db.prepare('DELETE FROM template_categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/templates', (req, res) => {
  const { category_id, label, text } = req.body;
  if (!category_id || !label || !text) return res.status(400).json({ error: 'Thiếu category_id, label hoặc text' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM templates WHERE category_id = ?').get(category_id).m;
  const info = db.prepare('INSERT INTO templates (category_id, label, text, sort_order) VALUES (?, ?, ?, ?)').run(category_id, label, text, maxOrder + 1);
  res.json({ id: info.lastInsertRowid });
});

router.put('/templates/:id', (req, res) => {
  const { label, text } = req.body;
  const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Không tìm thấy mẫu' });
  db.prepare('UPDATE templates SET label = ?, text = ? WHERE id = ?').run(label ?? existing.label, text ?? existing.text, req.params.id);
  res.json({ ok: true });
});

router.delete('/templates/:id', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ================= STATS ================= */
router.get('/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
  const unread = db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE unread_count > 0').get().n;
  const bookedTag = db.prepare("SELECT id FROM tags WHERE name = 'Đã đặt hẹn'").get();
  let booked = 0;
  if (bookedTag) {
    booked = db
      .prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM conversation_tags WHERE tag_id = ?')
      .get(bookedTag.id).n;
  }
  res.json({ total, unread, booked });
});

module.exports = router;
