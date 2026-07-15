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

// Form-webhook plugins (WP Webhooks, Zapier-style CF7/WPForms add-ons) often wrap the actual
// field values inside a nested object (e.g. { form_id, form_data: { "your-name": "...", ... },
// form_data_meta: {...} }) instead of sending them at the top level. We flatten everything to
// "path.to.key" -> value pairs first, so lookups and the fallback dump both see the real data
// instead of a top-level "[object Object]".
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, prefix ? `${prefix}[${i}]` : String(i), out));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  out[prefix] = obj;
  return out;
}

// Matches a flattened key by its last path segment (so "form_data.your-name" matches the
// alias "your-name"), case-insensitively.
function pick(flat, keys) {
  const wanted = keys.map((k) => k.toLowerCase());
  for (const [path, v] of Object.entries(flat)) {
    const lastSegment = path.split('.').pop().toLowerCase();
    if (wanted.includes(lastSegment) && v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return '';
}

const NAME_KEYS = ['your-name', 'your_name', 'name', 'full_name', 'fullname', 'ten', 'ho_ten', 'họ tên', 'họ và tên', 'field_1'];
const PHONE_KEYS = ['your-phone', 'your_phone', 'phone', 'so_dien_thoai', 'sdt', 'số điện thoại', 'tel', 'field_2', 'phone_number'];
const MESSAGE_KEYS = ['your-message', 'your_message', 'message', 'noi_dung', 'ghi_chu', 'nội dung', 'ghi chú', 'note', 'field_3'];
// Metadata keys some plugins (like WP Webhooks) send alongside the real submitted fields —
// noise we don't want cluttering the fallback dump shown to staff.
const NOISE_PREFIXES = ['form_id', 'form_title', 'form_data_meta', 'form_submit_data', 'meta.'];

router.post('/webhook/website-booking', (req, res) => {
  const token = req.query.token || req.get('x-webhook-token');
  if (token !== WEBSITE_TOKEN) return res.sendStatus(403);

  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const flat = flatten(rawBody);

  try {
    const name = pick(flat, NAME_KEYS) || 'Khách từ Website';
    const phone = pick(flat, PHONE_KEYS);
    let message = pick(flat, MESSAGE_KEYS);

    // Nothing matched our known field names — fall back to dumping every field we got,
    // so a form with unfamiliar field names still shows up with all its data instead of nothing.
    // Prefer entries under "form_data." (the real submitted fields on WP Webhooks) when present,
    // and always strip out known metadata noise either way.
    if (!message) {
      const known = new Set([...NAME_KEYS, ...PHONE_KEYS, ...MESSAGE_KEYS].map((k) => k.toLowerCase()));
      let entries = Object.entries(flat).filter(([path, v]) => {
        const lastSegment = path.split('.').pop().toLowerCase();
        const isNoise = NOISE_PREFIXES.some((p) => path === p || path.startsWith(p));
        return !known.has(lastSegment) && !isNoise && String(v ?? '').trim() !== '';
      });
      const formDataOnly = entries.filter(([path]) => path.startsWith('form_data.'));
      if (formDataOnly.length) entries = formDataOnly;
      message = entries.length
        ? entries.map(([path, v]) => `${path.replace(/^form_data\./, '')}: ${v}`).join('\n')
        : '(Không có nội dung)';
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
