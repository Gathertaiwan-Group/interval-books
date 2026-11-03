-- 0055 — MCP 報表匯出的私有 bucket（mcp-report-exports）
--
-- 階段 D 的 export_roster_csv／export_orders_csv／export_sales_csv 把產生的 CSV 上傳到這裡，
-- 回傳 15 分鐘到期的 signed URL（src/server/mcp/report-tools.ts）。CSV 裡有客人的姓名、
-- 電話、Email（明文，與後台名單匯出相同），所以這個 bucket 一定是**私有**的：
--
--   · public = false：沒有公開網址，只有 service_role（伺服器）簽出來的 signed URL 讀得到，
--     而且那個 URL 15 分鐘後失效。
--   · 與 0018 的 ocr-scans、0053 的 mcp-image-uploads 同一個寫法：**沒有任何
--     storage.objects policy** —— anon／authenticated 讀寫都不行。
--   · 只收 text/csv；上限 20 MiB（書店的訂單／銷售一年也遠低於此；超過時工具會要求縮小
--     日期範圍，不會靜默截斷）。
--
-- 已產生的檔案不自動清除（signed URL 過期後就沒有人讀得到；要清可以在 Supabase 後台刪）。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'mcp-report-exports',
  'mcp-report-exports',
  false,
  20971520,
  array['text/csv']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
