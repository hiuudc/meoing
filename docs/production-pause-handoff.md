# Meoing production pause handoff

**Trạng thái:** `PAUSED`  
**Cập nhật:** 2026-08-05 (Asia/Bangkok)  
**Lý do:** Tiếp tục hoàn thiện website và nghiệm thu staging trước khi xuất bản production.

## Quy tắc trong thời gian tạm dừng

- Không chạy workflow hay lệnh deploy production, không upload build Pages, không attach domain và không tạo/đổi production secret.
- Chỉ dùng staging cho việc phát triển, kiểm thử giao diện và dữ liệu.
- Mọi việc production tiếp theo phải tiếp tục từ checklist, không suy đoán rằng production website đã được xuất bản.

## Những gì đã hoàn thành và đã kiểm chứng

- Workers Paid, R2, Hyperdrive, API Worker và custom domain `api.meoing.com` đã tồn tại.
- API production đã từng trả `200` cho `/health/live` và `/health/ready`; request không có JWT trả `401`; CORS chỉ cho phép `https://meoing.com`.
- Production Supabase và staging Supabase cùng có 18 migration ứng dụng. Staging hiện có đủ 20 bảng thuộc schema `app`.
- API staging `https://api-staging.meoing.com` đang healthy, liên kết đúng Supabase staging và được frontend staging dùng.
- Cost Guard production chạy cron ở trạng thái `NORMAL`, có mốc cảnh báo 80% và detach API 95%; budget alert `$0.01` đã được tạo.
- Cloudflare SMTP đã gửi thành công invite canary production; canary và profile liên quan đã được dọn.
- Source đã có workflow backup weekly vào Chủ Nhật 02:23 UTC, giữ bốn bản và chỉ prune sau restore thành công.
- Project Pages `meoing-web-production` đã được tạo, nhưng **chưa có deployment production nào được tạo hay xuất bản**.

## Việc còn lại trước khi tiếp tục production

Theo đúng thứ tự trong [production-rollout-checklist.md](./production-rollout-checklist.md):

1. Xoay credential Cost Guard đã từng xuất hiện trong phiên cấu hình; sau đó kiểm thử Cost Guard trên staging với ngưỡng giả thấp.
2. Hoàn thành email verification, password reset, Google OAuth và xác nhận invite cũ không còn dùng được.
3. Cấu hình GitHub production secrets/variables, tạo weekly backup đầu tiên và thực hiện restore drill thành công.
4. Hoàn thành staging E2E, RLS/pgTAP, Worker integration, frontend build và load gate.
5. Chạy dependency audit, secret scan lịch sử Git, Supabase Advisors, live-cloud review và Codex Security theo checklist.
6. Chỉ khi các bước trên xanh mới build/deploy frontend production, gắn `meoing.com` và chạy production smoke test.

## Hướng phát triển hiện tại

- Website local được cấu hình (file `frontend/.env.local`, bị Git ignore) để xác thực với Supabase staging và gọi API staging qua Vite proxy cùng origin.
- Proxy chỉ lắng nghe `127.0.0.1:5173`; không nới CORS staging/production. Thay đổi source nằm ở commit `80e28b5` (`Configure local frontend staging proxy`).
- Dùng `npm run dev` từ `frontend/` để phát triển với tài khoản staging. Các luồng signup, reset và invite có Turnstile nên tiếp tục kiểm thử trên `https://staging.meoing.com`.

## Điểm bắt đầu khi mở lại production

1. Đọc file này và checklist trước.
2. Xác minh production vẫn ở trạng thái chưa deploy Pages và không có deploy/credential ngoài danh sách đã ghi.
3. Cập nhật checklist bằng bằng chứng kiểm thử mới, rồi tiếp tục từ mục chưa hoàn thành đầu tiên.

Không có token, password, publishable key hay URL ký R2 nào được lưu trong tài liệu này.
