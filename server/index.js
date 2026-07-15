// index.js — app entrypoint
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const { router: authRouter, requireAuth } = require('./routes/auth');
const webhookRouter = require('./routes/webhook');
const apiRouter = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook needs raw JSON body parsing too — express.json() covers it.
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'nha-khoa-inbox-secret-doi-di',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }, // 30 days
  })
);

// Meta webhook — NOT behind login (Meta calls this directly)
app.use('/', webhookRouter);

// Auth endpoints (login/logout/me) — not behind login (login itself can't require login)
app.use('/api/auth', authRouter);

// All other API routes require a logged-in session
app.use('/api', requireAuth, apiRouter);

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`Dental inbox app đang chạy tại http://localhost:${PORT}`);
});
