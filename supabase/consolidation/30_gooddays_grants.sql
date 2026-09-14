-- 好日子的 16 支 migration 從沒寫過 grant，靠 Supabase 對 public 的隱含全開撐著。
-- 搬進 gooddays schema 後沒有任何預設 grant，前台會全部 permission denied。
-- 這裡照 Supabase 對 public 的預設一模一樣補上；安全靠它自己的 25 條 RLS，不靠 grant。
grant usage on schema gooddays to anon, authenticated, service_role;
grant all on all tables    in schema gooddays to anon, authenticated, service_role;
grant all on all sequences in schema gooddays to anon, authenticated, service_role;
grant all on all functions in schema gooddays to anon, authenticated, service_role;
alter default privileges in schema gooddays grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema gooddays grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema gooddays grant all on functions to anon, authenticated, service_role;
-- gooddays_private 只放 is_admin()：不給 anon、PostgREST 也不曝露它（維持原本 private 的用意）。
grant usage on schema gooddays_private to authenticated, service_role;
grant execute on all functions in schema gooddays_private to authenticated, service_role;
alter default privileges in schema gooddays_private grant execute on functions to authenticated, service_role;
