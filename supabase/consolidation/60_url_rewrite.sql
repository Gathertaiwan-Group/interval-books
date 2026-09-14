-- 60_url_rewrite.sql — 14 列含舊專案 ref 的 URL 改寫。用 psql 變數帶入：
--   psql "$NEW_URL" -v new_ref=<新 ref> -v old_hh=soglfvjtysqqqzbcwwci -v old_gd=xptltqokykpmiqwlnasm -f 60_url_rewrite.sql
-- ⚠️ 骨架。site_settings.value 與 ai_chat_logs 的確切欄位要在有 token 時查清楚再填（見 README TODO）。
begin;
update happyhands.products      set cover_url = replace(cover_url, :'old_hh', :'new_ref') where cover_url like '%' || :'old_hh' || '%';
-- TODO happyhands.site_settings（1 列；value 欄位型別待查：text 直接 replace、jsonb 用 replace(value::text,…)::jsonb）
update gooddays.products        set images = replace(images::text, :'old_gd', :'new_ref')::jsonb where images::text like '%' || :'old_gd' || '%';
-- TODO gooddays.ai_chat_logs（2 列；含 ref 的欄位待查）
-- 改寫後不得殘留（70 的第 10 段會再驗一次）
select 'happyhands.products' t, count(*) left_over from happyhands.products p where p::text like '%' || :'old_hh' || '%'
union all select 'gooddays.products', count(*) from gooddays.products x where x::text like '%' || :'old_gd' || '%';
commit;
