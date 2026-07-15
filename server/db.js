// db.js — SQLite setup + schema + seed data
// Uses a single file DB under /data so it survives restarts on most hosts
// (on ephemeral hosts, mount a persistent disk at DB_PATH's folder).

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); // create the data/ folder if it wasn't uploaded
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  page_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  channel TEXT NOT NULL DEFAULT 'facebook',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_row_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  customer_psid TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT 'Khách hàng',
  customer_phone TEXT,
  last_message_preview TEXT NOT NULL DEFAULT '',
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(page_row_id, customer_psid)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  text TEXT NOT NULL DEFAULT '',
  staff_name TEXT,
  attachment_url TEXT,
  attachment_type TEXT CHECK(attachment_type IS NULL OR attachment_type IN ('image','video','file')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#2a78d6',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);

CREATE TABLE IF NOT EXISTS template_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES template_categories(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conv_page ON conversations(page_row_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
`);

// ---------- Lightweight migration for DBs created before attachments/staff_name existed ----------
const msgCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!msgCols.includes('staff_name')) db.exec('ALTER TABLE messages ADD COLUMN staff_name TEXT');
if (!msgCols.includes('attachment_url')) db.exec('ALTER TABLE messages ADD COLUMN attachment_url TEXT');
if (!msgCols.includes('attachment_type')) db.exec('ALTER TABLE messages ADD COLUMN attachment_type TEXT');
if (!msgCols.includes('fb_message_id')) db.exec('ALTER TABLE messages ADD COLUMN fb_message_id TEXT');
// Unique per-conversation only when fb_message_id is set (SQLite treats each NULL as distinct,
// so rows without an fb_message_id — sent from the app itself, or via webhook — never collide).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_fbid ON messages(conversation_id, fb_message_id)');

// ---------- Migration for DBs created before the "website booking" channel existed ----------
const pageCols = db.prepare("PRAGMA table_info(pages)").all().map((c) => c.name);
if (!pageCols.includes('channel')) db.exec("ALTER TABLE pages ADD COLUMN channel TEXT NOT NULL DEFAULT 'facebook'");
const convCols = db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name);
if (!convCols.includes('customer_phone')) db.exec('ALTER TABLE conversations ADD COLUMN customer_phone TEXT');

// Seed a single virtual "page" that all website-form bookings attach to (not a real Facebook page,
// so it has no access_token — just a container so bookings reuse the same conversations/messages tables).
const websitePage = db.prepare("SELECT * FROM pages WHERE channel = 'website'").get();
if (!websitePage) {
  db.prepare("INSERT INTO pages (name, page_id, access_token, channel) VALUES (?, ?, ?, 'website')").run(
    'Đặt lịch Website',
    'website-booking-form',
    ''
  );
}

// ---------- Seed default tags (dental-specific) ----------
const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
if (tagCount === 0) {
  const insertTag = db.prepare('INSERT INTO tags (name, color, sort_order) VALUES (?, ?, ?)');
  const defaultTags = [
    ['Khách tiềm năng', '#0ca30c', 1],
    ['Không tiềm năng', '#898781', 2],
    ['Đã đặt hẹn', '#2a78d6', 3],
    ['Đang chờ tư vấn', '#fab219', 4],
    ['Đã khám - chưa chốt', '#eb6834', 5],
    ['Cần gọi lại', '#d03b3b', 6],
    ['Khách quen / VIP', '#4a3aa7', 7],
  ];
  const insertMany = db.transaction((rows) => { for (const r of rows) insertTag.run(...r); });
  insertMany(defaultTags);
}
// Always make sure this tag exists (even on older DBs that already had tags seeded before
// the website-booking feature existed), so incoming website leads can be auto-tagged.
db.prepare('INSERT OR IGNORE INTO tags (name, color, sort_order) VALUES (?, ?, ?)').run(
  'Đặt lịch Website',
  '#1baf7a',
  999
);

// ---------- Seed default quick-reply templates ----------
const catCount = db.prepare('SELECT COUNT(*) AS n FROM template_categories').get().n;
if (catCount === 0) {
  const insertCat = db.prepare('INSERT INTO template_categories (name, sort_order) VALUES (?, ?)');
  const insertTpl = db.prepare('INSERT INTO templates (category_id, label, text, sort_order) VALUES (?, ?, ?, ?)');
  const seed = db.transaction(() => {
    const categories = [
      {
        name: 'Chào hỏi & Giới thiệu',
        items: [
          ['Chào mở đầu', 'Dạ em chào anh/chị, em là trợ lý tư vấn của nha khoa ạ. Anh/chị cho em xin tên và vấn đề răng miệng đang gặp phải để em tư vấn kỹ hơn nhé ạ!'],
          ['Giới thiệu chuyên khoa', 'Nha khoa em chuyên sâu về bảo tồn răng thật (điều trị tủy, trám thẩm mỹ, nha chu) trước khi cân nhắc các giải pháp thay thế, giúp anh/chị giữ răng thật lâu nhất có thể ạ.'],
        ],
      },
      {
        name: 'Tư vấn bảng giá',
        items: [
          ['Giá trám răng', 'Dạ giá trám răng thẩm mỹ dao động 300.000–800.000đ/răng tùy mức độ sâu răng ạ. Để báo giá chính xác, bên em cần chụp X-quang kiểm tra trực tiếp ạ.'],
          ['Giá điều trị tủy', 'Dạ điều trị tủy (lấy tủy + trám bít) dao động 1.500.000–3.000.000đ/răng tùy vị trí răng ạ, chưa bao gồm bọc sứ bảo vệ sau điều trị.'],
          ['Giá bọc răng sứ', 'Dạ bọc răng sứ có nhiều dòng sứ từ 2.500.000–8.000.000đ/răng, bên em sẽ tư vấn dòng sứ phù hợp sau khi thăm khám trực tiếp ạ.'],
        ],
      },
      {
        name: 'Đặt lịch hẹn',
        items: [
          ['Hỏi thời gian rảnh', 'Dạ anh/chị sắp xếp được khung giờ nào trong tuần này ạ? Bên em làm việc từ 8h–20h tất cả các ngày trong tuần, kể cả Chủ Nhật ạ.'],
          ['Xác nhận lịch hẹn', 'Dạ em đã giữ lịch khám cho anh/chị vào lúc [giờ] ngày [ngày]. Anh/chị đến trước 10 phút để làm thủ tục giúp em nhé ạ!'],
          ['Xin thông tin liên hệ', 'Anh/chị cho em xin số điện thoại để bên em tiện liên hệ xác nhận lịch hẹn ạ.'],
        ],
      },
      {
        name: 'Nhắc lịch & Chăm sóc sau',
        items: [
          ['Nhắc tái khám định kỳ', 'Dạ nha khoa xin nhắc anh/chị đã đến lịch tái khám định kỳ 6 tháng để kiểm tra và cạo vôi răng ạ.'],
          ['Dặn dò sau điều trị tủy', 'Sau điều trị tủy, anh/chị hạn chế ăn nhai bên răng vừa điều trị trong 24h. Nếu đau nhiều hoặc sưng, liên hệ ngay cho phòng khám nhé ạ.'],
        ],
      },
      {
        name: 'Bảo hiểm & Thanh toán',
        items: [
          ['Chính sách bảo hiểm', 'Dạ hiện tại phòng khám chưa liên kết trực tiếp bảo hiểm y tế, nhưng có hỗ trợ xuất hóa đơn để anh/chị làm thủ tục bảo hiểm sức khỏe tư nhân ạ.'],
          ['Hình thức thanh toán', 'Dạ phòng khám nhận thanh toán tiền mặt, chuyển khoản và quẹt thẻ. Hỗ trợ trả góp 0% cho dịch vụ từ 5 triệu trở lên ạ.'],
        ],
      },
    ];
    categories.forEach((cat, i) => {
      const catId = insertCat.run(cat.name, i + 1).lastInsertRowid;
      cat.items.forEach(([label, text], j) => insertTpl.run(catId, label, text, j + 1));
    });
  });
  seed();
}

module.exports = db;
