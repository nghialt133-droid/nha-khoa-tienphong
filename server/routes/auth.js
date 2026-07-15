// routes/auth.js — single shared-password login (per team's choice: one shared account)
//
// Uses a stateless, HMAC-signed cookie instead of server-side sessions. The old version used
// express-session's default MemoryStore, which keeps logged-in state only in the running
// process's RAM — so every deploy or restart (which happens often on Render, including plain
// code updates) silently logged every staff member out, surfacing as a confusing "Chưa đăng
// nhập" error on actions that clearly look logged-in. A signed cookie has no server-side state
// to lose: as long as SESSION_SECRET stays the same, a valid cookie keeps working across any
// number of restarts/redeploys.
const express = require('express');
const crypto = require('crypto');

const router = express.Router();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'doimatkhaunay';
const AUTH_SECRET = process.env.SESSION_SECRET || 'nha-khoa-inbox-secret-doi-di';
const COOKIE_NAME = 'nkbt_auth';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function sign(value) {
  const hmac = crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('hex');
  return `${value}.${hmac}`;
}

function verify(signed) {
  if (!signed || typeof signed !== 'string') return false;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return false;
  const value = signed.slice(0, idx);
  const hmac = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('hex');
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Manual cookie parsing — avoids adding the `cookie-parser` package as a new dependency.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie(COOKIE_NAME, sign('ok'), {
      httpOnly: true,
      maxAge: MAX_AGE_MS,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Sai mật khẩu' });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ loggedIn: verify(parseCookies(req)[COOKIE_NAME]) });
});

function requireAuth(req, res, next) {
  if (verify(parseCookies(req)[COOKIE_NAME])) return next();
  return res.status(401).json({ error: 'Chưa đăng nhập' });
}

module.exports = { router, requireAuth };
