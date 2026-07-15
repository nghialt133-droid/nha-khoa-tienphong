// index.js — app entrypoint
require('dotenv').config();
const path = require('path');
const express = require('express');

const { router: authRouter, requireAuth } = require('./routes/auth');
const webhookRouter = require('./routes/webhook');
const websiteRouter = require('./routes/website');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Render's proxy so req.secure / x-forwarded-proto reflect the real (https) request —
// needed for the login cookie's `secure` flag to be set correctly (see routes/auth.js).
app.set('trust proxy', 1);

// Webhook needs raw JSON body parsing too — express.json() covers it.
app.use(express.json());

// Meta webhook — NOT behind login (Meta calls this directly)
app.use('/', webhookRouter);

// Website booking webhook — NOT behind login (the WordPress plugin calls this directly,
// it's protected by its own secret ?token= instead of a session cookie).
app.use('/', websiteRouter);

// Auth endpoints (login/logout/me) — not behind login (login itself can't require login)
app.use('/api/auth', authRouter);

// All other API routes require a logged-in session
app.use('/api', requireAuth, apiRouter);

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Dental inbox app đang chạy tại http://localhost:${PORT}`);
});
