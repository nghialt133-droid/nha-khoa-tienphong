// routes/website.js — receives appointment-booking form submissions from the clinic's
// WordPress website (via a webhook plugin like WP Webhooks, Contact Form 7 + Webhook add-on,
// or WPForms webhooks add-on) and drops them into the same unified inbox as Facebook messages.
//
// This is intentionally forgiving about field names, since different form plugins send
// different keys — it tries a list of common aliases for name/phone/message, and falls
// back to dumping every field it received so nothing submitted on the form is ever lost.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();
const WEBSITE_TOKEN = process.env.WEBSITE_WEBHOOK_TOKEN || 'change_this_website_token';

function pick(body, keys) {
  for (const k of keys) {
    const v = body[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const NAME_KEYS = ['your-name', 'your_name', 'name', 'full_name', 'fullname', 'ten', 'ho_ten', 'họ tên', 'họ và tên', 'field_1'];
const PHONE_KEYS = ['your-phone', 'your_phone', 'phone', 'so_dien_thoai', 'sdt', 'số điện thoại', 'tel', 'field_2', 'phone_number'];
const MESSAGE_KEYS = ['your-message', 'your_message', 'message', 'noi_dung', 'ghi_chu', 'nội dung', 'ghi chú', 'note', 'field_3'];

router.post('/webhook/website-booking', (req, res) => {
  const token = req.query.token || req.get('x-webhook-token');
  if (token !== WEBSITE_TOKEN) return res.sendStatus(403);

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    const name = pick(body, NAME_KEYS) || 'Khách từ Website';
    const phone = pick(body, PHONE_KEYS);
    let message = pick(body, MESSAGE_KEYS);

    // Nothing matched our known field names — fall back to dumping every field we got,
    // so a form with unfamiliar field names still shows up with all its data instead of nothing.
    if (!message) {
      const known = new Set([...NAME_KEYS, ...PHONE_KEYS, ...MESSAGE_KEYS]);
      const rest = Object.entries(body).filter(([k, v]) => !known.has(k) && String(v || '').trim() !== '');
      message = rest.length ? rest.map(([k, v]) => `${k}: ${v}`).join('\n') : '(Không có nội dung)';
    }

    const websitePage = db.prepare("SELECT * FROM pages WHERE channel = 'website' LIMIT 1").get();
    if (!websitePage) return res.status(500).json({ error: 'Chưa khởi tạo kênh Website (liên hệ hỗ trợ kỹ thuật)' });

    const digits = phone.replace(/\D/g, '');
    const psid = digits ? `web_${digits}` : `web_${crypto.randomBytes(6).toString('hex')}`;

    let conv = db.prepare('SELECT * FROM conversations WHERE page_row_id = ? AND customer_psid = ?').get(websitePage.id, psid);
    const preview = `📅 Đặt lịch: ${message}`.slice(0, 140);
    let isNewConv = false;

    if (!conv) {
      isNewConv = true;
      const info = db
        .prepare(
          `INSERT INTO conversations (page_row_id, customer_psid, customer_name, customer_phone, last_message_preview, unread_count)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run(websitePage.id, psid, name, digits ? phone : null, preview);
      conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
    } else {
      db.prepare(
        `UPDATE conversations SET customer_name = ?, customer_phone = ?, last_message_preview = ?, last_message_at = datetime('now'), unread_count = unread_count + 1 WHERE id = ?`
      ).run(name, digits ? phone : conv.customer_phone, preview, conv.id);
    }

    const fullText = phone ? `☎ SĐT: ${phone}\n${message}` : message;
    db.prepare(`INSERT INTO messages (conversation_id, direction, text) VALUES (?, 'in', ?)`).run(conv.id, fullText);

    if (isNewConv) {
      const tag = db.prepare("SELECT id FROM tags WHERE name = 'Đặt lịch Website'").get();
      if (tag) db.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?, ?)').run(conv.id, tag.id);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('website-booking webhook error', e);
    res.status(500).json({ error: 'Xử lý đặt lịch thất bại' });
  }
});

module.exports = router;
