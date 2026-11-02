-- 0053 — MCP 圖片直傳的私有暫存 bucket（mcp-image-uploads）
--
-- create_image_upload_url 發的 Supabase signed upload URL 指向這裡，不是 site-images：
-- signed upload token 只綁「bucket＋路徑」，不綁大小、不綁內容；allowed_mime_types 也只看
-- 呼叫端自己報的 Content-Type。若直接發 site-images（公開讀）的 URL，一個還沒驗過的檔案
-- 在 finalize 之前就已經有公開網址了。所以先傳進這個**私有** bucket，由
-- finalize_image_upload 讀回、驗 magic bytes、轉存進 site-images，再刪掉暫存檔
-- （src/server/mcp/image-upload.ts）。
--
-- 與 0018 的 ocr-scans 同一個寫法：沒有任何 storage.objects policy —— anon／authenticated
-- 讀寫都不行，只有 service_role（伺服器）與 signed upload token 寫得進來。
-- file_size_limit 與 site-images 一致（2 MiB），MIME 只收三種點陣圖。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mcp-image-uploads',
  'mcp-image-uploads',
  false,
  2097152,
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
