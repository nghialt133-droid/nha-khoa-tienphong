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
const DATE_KEYS = ['appointment-date', 'appointment_date', 'ngay-hen', 'ngay_hen', 'ngày hẹn', 'date', 'field_3'];
const SERVICE_KEYS = ['dich-vu', 'dich_vu', 'dịch vụ', 'service', 'field_4'];
const MESSAGE_KEYS = ['your-message', 'your_message', 'message', 'noi_dung', 'ghi_chu', 'nội dung', 'ghi chú', 'note'];
// Metadata some plugins (like WP Webhooks) send ALONGSIDE the real submitted fields — e.g. the raw
// WordPress post object for the form itself (id/post_author/post_date/post_content/guid) and the
// form's notification-email template (mail/mail_2), which still contains unresolved merge tags like
// "[your-name]" rather than real values. None of this is data the customer actually typed — it's
// noise we never want cluttering the message shown to staff, so it's excluded by key (last path
// segment, case-insensitive) or by path prefix (for nested blocks like "mail.subject").
const NOISE_KEYS = new Set([
  'form_id', 'form_title', 'meta',
  'id', 'post_author', 'post_date', 'post_date_gmt', 'post_title', 'post_name',
  'post_type', 'post_status', 'post_content', 'post_excerpt', 'guid',
  'locale', 'title', 'sent', 'invalid_fields', 'skip_mail', 'uploaded_data',
  // Some WP Webhooks setups flatten the CF7 "mail" template's own fields to the TOP level
  // (no "mail." prefix) — these are the notification-email settings, not submitted data.
  'active', 'subject', 'sender', 'recipient', 'body', 'additional_headers',
  'attachments', 'use_html', 'exclude_blank', 'mail_2',
].map((k) => k.toLowerCase()));
const NOISE_PATH_PREFIXES = ['form_data_meta', 'form_submit_data', 'meta.', 'form.', 'mail.', 'mail_2.'];

router.post('/webhook/website-booking', (req, res) => {
  const token = req.query.token || req.get('x-webhook-token');
  if (token !== WEBSITE_TOKEN) return res.sendStatus(403);

  const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
  const flat = flatten(rawBody);
  // Logged so we can see the exact shape WordPress/WP Webhooks actually sends, in case a form
  // uses field names we don't recognize yet — check Render's Logs tab if a booking looks wrong.
  console.log('website-booking payload:', JSON.stringify(rawBody));

  try {
    const name = pick(flat, NAME_KEYS) || 'Khách từ Website';
    const phone = pick(flat, PHONE_KEYS);
    const date = pick(flat, DATE_KEYS);
    const service = pick(flat, SERVICE_KEYS);
    let message = pick(flat, MESSAGE_KEYS);

    // Build a clean message from the fields we recognize by name (date/service), instead of
    // dumping the raw payload — avoids ever showing WordPress/email-template noise.
    if (!message) {
      const parts = [];
      if (service) parts.push(`Dịch vụ cần tư vấn: ${service}`);
      if (date) parts.push(`Ngày hẹn mong muốn: ${date}`);
      message = parts.join('\n');
    }

    // Still nothing recognized at all — fall back to dumping whatever unfamiliar fields we got,
    // so a form with field names we've never seen still shows up with its data instead of nothing.
    // Prefer entries under "form_data." (the real submitted fields on WP Webhooks) when present,
    // and always strip out known metadata/template noise either way.
    if (!message) {
      const known = new Set([...NAME_KEYS, ...PHONE_KEYS, ...DATE_KEYS, ...SERVICE_KEYS, ...MESSAGE_KEYS].map((k) => k.toLowerCase()));
      let entries = Object.entries(flat).filter(([path, v]) => {
        const lastSegment = path.split('.').pop().toLowerCase();
        const pathLower = path.toLowerCase();
        const isNoise = NOISE_KEYS.has(lastSegment) || NOISE_PATH_PREFIXES.some((p) => pathLower === p.replace(/\.$/, '') || pathLower.startsWith(p));
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
