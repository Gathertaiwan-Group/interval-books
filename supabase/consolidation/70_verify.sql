-- 70_verify.sql — 在「目標專案」上跑，每一段都印出實際值與期望值；任何一段不符就停下來。
-- 期望值來自 2026-09-14 三站盤點（drift/ 快照）：public 39 表／98 函式、inv 21／35（policy 74 全在 public）、happyhands 20／28、gooddays 16／8＋private 1。

\echo '=== 1. 表數（期望 public 39, inv 21, happyhands 20, gooddays 16）==='
select schemaname, count(*) from pg_tables where schemaname in ('public','inv','happyhands','gooddays','gooddays_private') group by 1 order by 1;

\echo '=== 2. 函式數（期望 public 98+1 wrapper=99, inv 35, happyhands 28+1=29, gooddays 8+1=9, gooddays_private 1）==='
select n.nspname, count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','inv','happyhands','gooddays','gooddays_private') group by 1 order by 1;

\echo '=== 3. policy 數（期望 public+inv 74, happyhands 21, gooddays 25）==='
select schemaname, count(*) from pg_policies where schemaname in ('public','inv','happyhands','gooddays') group by 1 order by 1;

\echo '=== 4. 🔴 search_path 稽核：新 schema 的 security definer 函式不可以把 public 放進 search_path（期望 0 列）==='
select n.nspname, p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where p.prosecdef and n.nspname in ('happyhands','gooddays','gooddays_private')
   and exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c ilike 'search_path=%public%');

\echo '=== 5. 🔴 新 schema 的函式本體不可殘留 public.（期望 0 列）==='
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('happyhands','gooddays','gooddays_private')
   and (case when p.prokind in ('f','p') then pg_get_functiondef(p.oid) end) ~ '\mpublic\.';  -- CASE 保證不對 aggregate 呼叫 pg_get_functiondef（planner 可能先算再過濾）

\echo '=== 6. 🔴 view 只依賴自己 schema（期望 0 列）==='
select distinct vn.nspname||'.'||v.relname as view, dn.nspname||'.'||d.relname as depends_on
  from pg_depend dep join pg_rewrite r on r.oid=dep.objid join pg_class v on v.oid=r.ev_class join pg_namespace vn on vn.oid=v.relnamespace
  join pg_class d on d.oid=dep.refobjid join pg_namespace dn on dn.oid=d.relnamespace
 where v.relkind='v' and vn.nspname in ('happyhands','gooddays') and dn.nspname<>vn.nspname and dn.nspname not in ('pg_catalog','auth');

\echo '=== 7. auth.users 上的 trigger（期望三個 *_on_auth_user_created，沒有舊的 on_auth_user_created）==='
select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal order by 1;

\echo '=== 8. grant：新 schema 對 service_role 有 usage（期望兩列 true）==='
select 'happyhands' s, has_schema_privilege('service_role','happyhands','USAGE') union all select 'gooddays', has_schema_privilege('service_role','gooddays','USAGE');

\echo '=== 9. 資料列數（載入後跑；期望與來源 count(*) 逐表相等，見 README 的來源列數表）==='
select 'auth.users' t, count(*) from auth.users union all
select 'public.profiles', count(*) from public.profiles union all
select 'happyhands.profiles', count(*) from happyhands.profiles union all
select 'gooddays.profiles', count(*) from gooddays.profiles union all
select 'happyhands.orders', count(*) from happyhands.orders union all
select 'gooddays.orders', count(*) from gooddays.orders union all
select 'public.orders', count(*) from public.orders union all
select 'inv.purchases', count(*) from inv.purchases;

\echo '=== 10. 舊 ref 殘留（URL 改寫後跑；期望 0）==='
select 'happyhands.products' t, count(*) from happyhands.products p where p::text ~ 'soglfvjtysqqqzbcwwci' union all
select 'happyhands.site_settings', count(*) from happyhands.site_settings x where x::text ~ 'soglfvjtysqqqzbcwwci' union all
select 'gooddays.products', count(*) from gooddays.products x where x::text ~ 'xptltqokykpmiqwlnasm' union all
select 'gooddays.ai_chat_logs', count(*) from gooddays.ai_chat_logs x where x::text ~ 'xptltqokykpmiqwlnasm';
