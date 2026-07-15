# Hộp thư hợp nhất Fanpage — Nha Khoa

Gộp tin nhắn Facebook Messenger từ tối đa 5 fanpage vào 1 giao diện, gắn tag phân loại khách (khách tiềm năng, đã đặt hẹn, cần gọi lại...), có sẵn thư viện tin nhắn soạn sẵn cho nhân viên trực.

> Chỉ hỗ trợ **Facebook Messenger**. TikTok không có API công khai cho DM thông thường (chỉ có TikTok Shop) nên không nằm trong phạm vi bản này.

## Tính năng

- Gộp tin nhắn của tối đa 5 fanpage, gắn/gỡ tag phân loại khách (màu tự chọn), lọc theo fanpage hoặc tag.
- Gửi/nhận **ảnh và video** (nút 📎 trong khung soạn tin), không chỉ tin nhắn văn bản. Link trong tin nhắn tự động thành link bấm được.
- Thư viện tin nhắn soạn sẵn — thêm/sửa/xoá thoải mái trong **⚙ Cài đặt**.
- Dùng chung 1 mật khẩu đăng nhập cho cả team, nhưng mỗi người đặt "Tên của bạn" riêng (lưu trên trình duyệt từng máy) để đồng nghiệp biết ai đã trả lời tin nào — nhiều người dùng đồng thời được, không giới hạn 2-3 người.
- Giao diện responsive, dùng được trên điện thoại (mở bằng trình duyệt Chrome/Safari trên điện thoại, có thể "Thêm vào màn hình chính" để dùng như app).
- Thông báo trên màn hình khi có tin nhắn mới — bấm nút "🔔 Bật thông báo" trong ứng dụng, trình duyệt sẽ hỏi xin quyền một lần.
  - **Giới hạn quan trọng**: thông báo chỉ hoạt động khi trình duyệt/tab hoặc app (nếu đã thêm vào màn hình chính) đang mở — kể cả chạy nền. Nếu tắt hẳn trình duyệt/app thì sẽ không nhận được thông báo (giống hầu hết web app khác). Muốn có thông báo kiểu "app đóng vẫn báo" (như Messenger/Zalo) cần thêm hạ tầng Web Push (service worker + server gửi push) — có thể làm thêm nếu cần, báo lại để bổ sung.

## Chạy thử ở máy local

```bash
npm install
cp .env.example .env   # rồi mở .env sửa mật khẩu, verify token...
npm start
```

Mở `http://localhost:3000`, đăng nhập bằng `ADMIN_PASSWORD` đã đặt trong `.env`.

## Cấu trúc

```
server/
  index.js          # entrypoint, gắn route + session + static
  db.js             # schema SQLite + seed dữ liệu mặc định (tag, mẫu tin nhắn)
  facebook.js        # gọi Graph API để gửi tin & lấy tên khách
  routes/
    auth.js         # đăng nhập chung 1 mật khẩu cho cả team
    webhook.js       # nhận tin nhắn thật từ Meta (webhook)
    api.js           # API cho frontend: hội thoại, tag, mẫu tin nhắn, fanpage
public/
  index.html / app.js / style.css   # giao diện, gọi thẳng API ở trên
data/
  app.db            # database SQLite (tự tạo khi chạy lần đầu)
```

## Deploy lên hosting (để có URL public, webhook mới hoạt động)

Cần một host public HTTPS chạy Node.js liên tục — gợi ý các lựa chọn có gói miễn phí/giá rẻ: **Render.com**, **Railway.app**, hoặc một VPS nhỏ (vd DigitalOcean, Vietnix...). Các bước chung:

1. Đẩy code (thư mục này) lên GitHub repo riêng (private).
2. Trên Render/Railway: New → Web Service → chọn repo → Build command `npm install`, Start command `npm start`.
3. Khai báo Environment Variables giống nội dung `.env.example` (ADMIN_PASSWORD, SESSION_SECRET, WEBHOOK_VERIFY_TOKEN...).
4. **Quan trọng**: nếu host dùng ổ đĩa tạm (ephemeral disk), database SQLite sẽ mất dữ liệu mỗi lần deploy lại — cần gắn "Persistent Disk"/"Volume" và trỏ `DB_PATH` vào đó (Render: mục Disks; Railway: Volumes).
5. Sau khi deploy xong sẽ có 1 URL dạng `https://ten-app.onrender.com`. Vào app → **Cài đặt** để xem sẵn Webhook URL (`.../webhook`) và Verify Token → dán vào Meta App (xem file hướng dẫn `HUONG-DAN-SETUP.docx`).

## Giới hạn chính sách quan trọng

- **Cửa sổ 24 giờ**: Facebook chỉ cho phép trả lời tự do trong vòng 24 giờ kể từ tin nhắn cuối của khách. Ngoài khung này, cần dùng message tag đặc biệt (không có trong bản này) hoặc chờ khách nhắn lại.
- **App Review**: để nhận tin thật từ khách bất kỳ (không chỉ admin/tester của Meta App), quyền `pages_messaging` cần được Meta duyệt (App Review) — xem hướng dẫn kèm theo.
- Đây là bản MVP dùng chung 1 tài khoản đăng nhập cho cả team (theo yêu cầu), chưa phân quyền theo từng nhân viên.
