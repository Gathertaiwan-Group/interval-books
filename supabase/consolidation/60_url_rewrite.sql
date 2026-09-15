-- 60_url_rewrite.sql — 14 列含舊專案 ref 的 URL 改寫（欄位已於 2026-09-15 實查確認）。
--   psql "$NEW_URL" -v new_ref=<新 ref> -v old_hh=soglfvjtysqqqzbcwwci -v old_gd=xptltqokykpmiqwlnasm -f 60_url_rewrite.sql
--   （run_sql.py 跑時會先把 :'var' 換成字面值）
begin;
-- 🔴 replica 模式：這四張表都有 set_updated_at trigger，直接 update 會把 14 列的 updated_at 蓋成搬遷當下時間
--    （2026-09-15 第三次排練用 md5 逐表比對時抓到）。搬遷不該改資料的時間戳。
set local session_replication_role = replica;
update happyhands.products      set cover_url = replace(cover_url, :'old_hh', :'new_ref')               where cover_url like '%' || :'old_hh' || '%';           -- 8 列
update happyhands.site_settings set value     = replace(value::text, :'old_hh', :'new_ref')::jsonb      where key = 'teacher' and value::text like '%' || :'old_hh' || '%';  -- 1 列
update gooddays.products        set images    = replace(images::text, :'old_gd', :'new_ref')::jsonb     where images::text like '%' || :'old_gd' || '%';        -- 3 列
update gooddays.ai_chat_logs    set messages  = replace(messages::text, :'old_gd', :'new_ref')::jsonb   where messages::text like '%' || :'old_gd' || '%';      -- 2 列
-- 改寫後不得殘留（70 第 10 段會再驗）
select 'happyhands.products' t, count(*) left_over from happyhands.products p where p::text like '%' || :'old_hh' || '%'
union all select 'happyhands.site_settings', count(*) from happyhands.site_settings x where x::text like '%' || :'old_hh' || '%'
union all select 'gooddays.products',        count(*) from gooddays.products x where x::text like '%' || :'old_gd' || '%'
union all select 'gooddays.ai_chat_logs',    count(*) from gooddays.ai_chat_logs x where x::text like '%' || :'old_gd' || '%';
commit;
