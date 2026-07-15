// facebook.js — thin wrapper around the Meta Graph API (Messenger Platform)
// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Send a text message to a customer (PSID) using a page's access token.
 * NOTE: Meta only allows free-form replies within 24h of the customer's last
 * message ("24-hour standard messaging window"). Outside that window, a
 * message tag (e.g. CONFIRMED_EVENT_UPDATE) or a new customer-initiated
 * message is required. This app does not attempt to bypass that policy.
 */
async function sendTextMessage(pageAccessToken, psid, text) {
  const url = `${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const body = {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph API error (${res.status})`);
    err.graph = data;
    throw err;
  }
  return data;
}

/**
 * Send an image/video/file attachment (by public URL) to a customer.
 * Facebook fetches the file itself, so `url` must be publicly reachable —
 * that's why uploaded files are served back from this app's own /uploads path.
 */
async function sendAttachment(pageAccessToken, psid, url, type) {
  const url_ = `${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`;
  const body = {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { attachment: { type, payload: { url, is_reusable: true } } },
  };
  const res = await fetch(url_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph API error (${res.status})`);
    err.graph = data;
    throw err;
  }
  return data;
}

/**
 * Best-effort fetch of a customer's display name + Messenger profile picture via their PSID.
 * Always resolves (never throws) — returns { name: string|null, avatarUrl: string|null } so
 * callers can freely fall back to a generated placeholder name / initials avatar.
 */
async function fetchUserProfile(pageAccessToken, psid) {
  try {
    const url = `${GRAPH_BASE}/${psid}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Logged (not thrown) so a failed profile/avatar lookup never breaks messaging —
      // but we can see *why* it failed in Render's Logs tab instead of guessing.
      console.error(`fetchUserProfile failed for psid ${psid}:`, JSON.stringify(data?.error || data));
      return { name: null, avatarUrl: null };
    }
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
    return { name: name || null, avatarUrl: data.profile_pic || null };
  } catch (e) {
    console.error(`fetchUserProfile threw for psid ${psid}:`, e.message);
    return { name: null, avatarUrl: null };
  }
}

/**
 * Pull a Page's conversation history from the Graph API Conversations endpoint
 * (Meta Business Inbox data — separate from the webhook, which only streams
 * NEW messages going forward). Returns messages no older than `sinceMs`.
 *
 * Conversations come back newest-first (by updated_time), so we stop paging
 * as soon as an entire page of conversations is older than the cutoff.
 */
async function fetchConversationHistory(pageAccessToken, sinceMs, { maxConversations = 200 } = {}) {
  const conversations = [];
  let url =
    `${GRAPH_BASE}/me/conversations?fields=` +
    encodeURIComponent('participants,updated_time,messages.limit(100){id,message,from,to,created_time,attachments{id,mime_type,name,file_url}}') +
    `&limit=25&access_token=${encodeURIComponent(pageAccessToken)}`;

  while (url && conversations.length < maxConversations) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Graph API error (${res.status})`);
      err.graph = data;
      throw err;
    }
    let hitOldConversation = false;
    for (const conv of data.data || []) {
      const updatedMs = conv.updated_time ? new Date(conv.updated_time).getTime() : 0;
      if (updatedMs && updatedMs < sinceMs) { hitOldConversation = true; continue; }
      conversations.push(conv);
      if (conversations.length >= maxConversations) break;
    }
    // Conversations are sorted newest-first — once a whole page is older than the
    // cutoff, everything after it is older too, so stop paging.
    const allOldThisPage = (data.data || []).length > 0 && (data.data || []).every((c) => {
      const t = c.updated_time ? new Date(c.updated_time).getTime() : 0;
      return t && t < sinceMs;
    });
    if (allOldThisPage) break;
    url = data.paging && data.paging.next ? data.paging.next : null;
  }
  return conversations;
}

module.exports = { sendTextMessage, sendAttachment, fetchUserProfile, fetchConversationHistory, GRAPH_BASE };
