# Meoing production rollout checklist

> Cập nhật lần cuối: 2026-08-05 (Asia/Bangkok).  
> Chỉ đánh dấu `[x]` khi đã có kiểm chứng trực tiếp trên hạ tầng production.

## Hạ tầng Cloudflare và API

- [x] Workers Paid đã bật.
- [x] R2 buckets production được tạo và R2 CORS chỉ cho phép `https://meoing.com`.
- [x] Hyperdrive production cho API và Maintenance Worker hoạt động.
- [x] API Worker có custom domain `api.meoing.com`.
- [x] `GET /health/live` và `GET /health/ready` trên `api.meoing.com` trả thành công.
- [x] API production kiểm tra JWT, trả `401` khi không có token, và CORS chỉ cho phép `https://meoing.com`.
- [x] Cost Guard production đang chạy theo cron, đọc usage thành công và đang ở trạng thái `NORMAL`.
- [x] Cost Guard được cấu hình cảnh báo ở 80% và detach API ở 95%; không tự bật lại.
- [x] Cloudflare usage budget alert `$0.01` đã được tạo.
- [ ] Xoay credential Cost Guard đang hiển thị trong phiên cấu hình trước khi nghiệm thu cuối.
- [ ] Chạy Cost Guard staging với threshold giả thấp: warning, detach, idempotency và manual resume.

## Supabase Auth

- [x] Supabase production URL configuration dùng Site URL `https://meoing.com`.
- [x] Redirect allow-list có chính xác `https://meoing.com/auth/callback`.
- [x] Tạo Cloudflare account API token `meoing-supabase-smtp-production-final` chỉ có `Email Sending: Write`; đã thu hồi các token production trùng.
- [x] Bật Custom SMTP trong Supabase: `smtp.mx.cloudflare.net:465`, TLS ngầm, username `api_token`, sender `no-reply@auth.meoing.com`.
- [x] Gửi invite canary qua Cloudflare SMTP; Supabase Auth ghi nhận `200` và user có marker `app_metadata.meoing_acceptance`.
- [ ] Kiểm tra email xác minh bằng canary có `app_metadata.meoing_acceptance`.
- [ ] Kiểm tra password reset bằng canary có marker.
- [x] Xóa canary invite có marker và profile cascade; xác minh Auth user/profile không còn tồn tại.
- [ ] Xác nhận trực tiếp invite link cũ không còn dùng được.
- [ ] Bật Google provider trên Supabase production, với callback `https://rckeolmhsnkpcamlheds.supabase.co/auth/v1/callback` trong Google OAuth client.
- [ ] Kiểm tra đăng nhập Google production và callback về `https://meoing.com/auth/callback`.
- [x] Xác nhận Auth email rate limit production tối đa 2 email/giờ.

## Frontend và tên miền

- [ ] Deploy build frontend production với `VITE_MEOI_API_URL=https://api.meoing.com`, Supabase URL production, publishable key và Turnstile site key.
- [ ] Xác nhận `https://meoing.com` phân giải DNS và tải được website.
- [ ] Xác nhận auth gate, signup/verify, sign-in và onboarding username trên website production.
- [ ] Xác nhận extension Lesson v8 gửi progress vào API production.

## Backup, CI và vận hành

- [x] Source có workflow backup weekly vào Chủ Nhật 02:23 UTC, giữ 4 bản và chỉ prune sau restore thành công.
- [ ] Cấu hình GitHub production secrets/variables cần cho deploy, backup và restore drill.
- [ ] Chạy weekly backup production đầu tiên; giải mã, restore DB tạm và xác nhận checksum/schema/row-count.
- [ ] Xóa `daily/` backup cũ sau weekly restore đầu tiên thành công.
- [ ] Kiểm tra cảnh báo khi weekly backup mới nhất quá 8 ngày.
- [ ] Thiết lập manual-approval cho workflow `cost-guard-resume`.
- [ ] Chạy staging E2E, RLS/pgTAP, Worker integration, frontend test/build và load gate.

## Bảo mật và nghiệm thu trước production

- [ ] Revoke toàn bộ Brevo SMTP/API credentials và bỏ sender/domain Brevo; kiểm tra Supabase/GitHub không còn Brevo secret.
- [ ] Chạy dependency audit, Git-history secret scan, Supabase Security/Performance Advisors và live-cloud configuration review.
- [ ] Chạy Codex Security diff scan cho thay đổi auth/RLS/storage/deployment; quét full repository trước deploy production đầu tiên.
- [ ] Xác nhận trực tiếp Supabase Data API không đọc/ghi được `app` data.
- [ ] Xác nhận không truy cập chéo collection, không role escalation/replay invite/progress/upload, và không gắn R2 asset chéo chủ sở hữu.
- [ ] Đối chiếu giới hạn chi phí: Workers/R2/Email quota, Cost Guard và asset quota theo mức $5/tháng đã chọn.

## Định nghĩa hoàn thành

- [ ] Toàn bộ checklist trên đã hoàn thành, trừ các mục chỉ áp dụng sau khi mở rộng phạm vi.
- [ ] Production smoke test xác nhận Auth, API, PostgreSQL, R2, extension và progress hoạt động cùng nhau.
- [ ] Có bản backup restore được, CI xanh và không còn finding bảo mật nghiêm trọng/cao chưa xử lý.
