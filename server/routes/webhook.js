// routes/webhook.js — Meta Messenger Platform webhook (verify + receive)
const express = require('express');
const db = require('../db');
const { fetchUserProfile } = require('../facebook');

const router = express.Router();
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'change_this_verify_token';

// ---- 1) Verification handshake (Meta calls this once when you save the webhook config) ----
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---- 2) Receiving events (new messages) ----
// Meta requires a 200 response within a few seconds, so we ack immediately
// and do the work synchronously here since it's fast (SQLite, local writes).
router.post('/webhook', (req, res) => {
  const body = req.body;
  // Logged unconditionally so Render's Logs tab always shows proof that Meta actually called this
  // endpoint at all — the fastest way to tell "Meta isn't delivering the event" apart from
  // "Meta delivered it but our code failed to process it".
  console.log(`webhook: nhận được POST /webhook lúc ${new Date().toISOString()}, object=${body.object}, số entry=${(body.entry || []).length}`);
  if (body.object !== 'page') return res.sendStatus(404);

  res.status(200).send('EVENT_RECEIVED'); // ack first

  try {
    for (const entry of body.entry || []) {
      const pageId = entry.id; // Facebook Page ID that received the message
      const page = db.prepare('SELECT * FROM pages WHERE page_id = ? AND active = 1').get(pageId);
      if (!page) {
        // Logged so this shows up in Render's Logs tab — the most common cause is the fanpage
        // connection getting wiped (Render Free tier has no persistent disk, so a code deploy
        // resets the database) and never being reconnected in Settings afterward.
        console.error(`webhook: tin nhắn đến từ Page ID ${pageId} nhưng fanpage này chưa được kết nối trong app (hoặc đã bị mất kết nối) — vào Cài đặt để kết nối lại.`);
        continue;
      }

      for (const evt of entry.messaging || []) {
        if (!evt.message || evt.message.is_echo) continue; // skip echoes of our own sent messages
        const psid = evt.sender.id;
        const text = evt.message.text || '';
        const att = (evt.message.attachments || [])[0]; // Messenger sends one attachment per message
        let attachment_url = null;
        let attachment_type = null;
        if (att) {
          attachment_url = att.payload?.url || null;
          attachment_type = att.type === 'image' ? 'image' : att.type === 'video' ? 'video' : 'file';
        }
        const displayText = text || (attachment_type ? '' : '[Tin nhắn không đọc được]');
        console.log(`webhook: tin nhắn mới — Page "${page.name}" (${pageId}), PSID ${psid}: "${displayText.slice(0, 80)}"`);
        handleIncomingMessage(page, psid, displayText, attachment_url, attachment_type)
          .then(() => console.log(`webhook: đã lưu tin nhắn vào hội thoại (PSID ${psid})`))
          .catch((e) => console.error('handleIncomingMessage error', e));
      }
    }
  } catch (e) {
    console.error('webhook processing error', e);
  }
});

async function handleIncomingMessage(page, psid, text, attachment_url, attachment_type) {
  const preview = text || (attachment_type === 'image' ? '📷 Đã gửi ảnh' : attachment_type === 'video' ? '🎥 Đã gửi video' : attachment_type ? '📎 Đã gửi file' : '');
  let conv = db
    .prepare('SELECT * FROM conversations WHERE page_row_id = ? AND customer_psid = ?')
    .get(page.id, psid);

  if (!conv) {
    const profile = await fetchUserProfile(page.access_token, psid);
    const name = profile.name || `Khách hàng #${psid.slice(-5)}`;
    const info = db
      .prepare(
        `INSERT INTO conversations (page_row_id, customer_psid, customer_name, customer_avatar_url, last_message_preview, unread_count)
         VALUES (?, ?, ?, ?, ?, 1)`
      )
      .run(page.id, psid, name, profile.avatarUrl, preview.slice(0, 140));
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare(
      `UPDATE conversations SET last_message_preview = ?, last_message_at = datetime('now'), unread_count = unread_count + 1 WHERE id = ?`
    ).run(preview.slice(0, 140), conv.id);
    // NOTE: no longer attempting to backfill customer_avatar_url here — Facebook rejects this
    // Graph API call for real customers (requires Meta App Review), so it always failed and just
    // added noise + wasted calls on every single incoming message. Decision: keep the initials
    // avatar fallback instead (see public/app.js avatarAttrs()).
  }

  db.prepare(
    `INSERT INTO messages (conversation_id, direction, text, attachment_url, attachment_type) VALUES (?, 'in', ?, ?, ?)`
  ).run(conv.id, text, attachment_url, attachment_type);
}

module.exports = router;
