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

/** Best-effort fetch of a customer's display name via their PSID. */
async function fetchUserProfile(pageAccessToken, psid) {
  try {
    const url = `${GRAPH_BASE}/${psid}?fields=first_name,last_name&access_token=${encodeURIComponent(pageAccessToken)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
    return name || null;
  } catch {
    return null;
  }
}

module.exports = { sendTextMessage, sendAttachment, fetchUserProfile, GRAPH_BASE };
