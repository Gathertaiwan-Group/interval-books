-- 71_behaviour_checks.sql — 行為驗證：70 看的是 catalog，這裡真的去「跑」出來看，針對計畫裡兩個最陰的失敗模式。
--   psql "$NEW_URL" -v ON_ERROR_STOP=1 -f 71_behaviour_checks.sql
-- 任何一段的 ok 不是 true 就停手。

\echo '=== 1. 🔴 好日子的 is_admin() 不可以看小時光的 profiles ==='
-- 風險 9：原本 private.is_admin() 是 `set search_path to public` 讀 public.profiles；
-- 不改寫的話，小時光的 admin 會靜默變成好日子的 admin。（20 最後會 drop 掉過渡用的 gooddays.is_admin()，
-- 23 條 policy 全部改指 gooddays_private.is_admin()，所以這裡只驗這一支。）
select 'policy 指向' as 檢查,
       count(*) filter (where qual like '%gooddays_private.is_admin%' or with_check like '%gooddays_private.is_admin%') as 指向gooddays_private,
       count(*) filter (where qual like '%public.is_admin%' or with_check like '%public.is_admin%') as 指向public,
       count(*) filter (where qual like '%public.is_admin%' or with_check like '%public.is_admin%') = 0
   and count(*) filter (where qual like '%gooddays_private.is_admin%' or with_check like '%gooddays_private.is_admin%') = 23 as ok
  from pg_policies where schemaname = 'gooddays';

-- 挑一個「在小時光是 admin、在好日子不是」的帳號，冒充它呼叫 is_admin()，必須 false
with victim as (
  select p.id from public.profiles p
    join gooddays.profiles g on g.id = p.id
   where p.role = 'admin' and coalesce(g.role, '') <> 'admin'
   limit 1
), impersonate as (
  select id, set_config('request.jwt.claim.sub', id::text, true) from victim
)
select '冒充小時光 admin' as 檢查, (select id from impersonate) as 帳號,
       gooddays_private.is_admin() as 回傳,
       (select count(*) from victim) = 1 and gooddays_private.is_admin() = false as ok;
select set_config('request.jwt.claim.sub', '', true);

\echo '=== 2. 好日子自己的 admin 仍然是 admin（上一段不是因為函式壞掉才 false）==='
with gd_admin as (select id from gooddays.profiles where role = 'admin' limit 1),
     impersonate as (select id, set_config('request.jwt.claim.sub', id::text, true) from gd_admin)
select coalesce((select id::text from impersonate), '（好日子沒有 admin 帳號，這段不適用）') as 冒充,
       gooddays_private.is_admin() as 回傳,
       case when exists (select 1 from gd_admin) then gooddays_private.is_admin() else true end as ok;
select set_config('request.jwt.claim.sub', '', true);

\echo '=== 3. 🔴 PostgREST 的 search_path 陷阱：happyhands/gooddays 裡的裸表名不可以落到小時光 ==='
-- PostgREST 會用 `<schema>, public, extensions`；新 schema 的函式若有未限定的表名，找不到就會靜默用小時光的同名表。
-- 做法：在那個 search_path 之下，比對兩站與小時光的同名表列數——各站必須讀到自己的數字。
begin;
set local search_path = happyhands, public, extensions;   -- 🔴 set local 一定要在交易裡，不然靜默無效
select 'happyhands' as schema, (select count(*) from products) as 看到的products,
       (select count(*) from happyhands.products) as 應該是,
       (select count(*) from products) = (select count(*) from happyhands.products) as ok;
commit;
begin;
set local search_path = gooddays, public, extensions;
select 'gooddays', (select count(*) from products), (select count(*) from gooddays.products),
       (select count(*) from products) = (select count(*) from gooddays.products);
commit;

\echo '=== 4. security definer 函式一定要釘住自己的 search_path（沒設＝跟著呼叫者跑）==='
select n.nspname, p.proname, coalesce(array_to_string(p.proconfig, ','), '（沒設 search_path）') as proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.prosecdef and n.nspname in ('happyhands','gooddays','gooddays_private')
   and (not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')   -- 沒釘＝跟著呼叫者跑
        or exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%public%'));  -- 釘到小時光
\echo '（期望 0 列）'

\echo '=== 5. 三個 auth trigger 的扇出：每個帳號在三個 schema 都要有 profile ==='
select (select count(*) from auth.users) as 帳號,
       (select count(*) from auth.users u where not exists (select 1 from public.profiles x where x.id = u.id)) as 缺小時光,
       (select count(*) from auth.users u where not exists (select 1 from happyhands.profiles x where x.id = u.id)) as 缺快樂手,
       (select count(*) from auth.users u where not exists (select 1 from gooddays.profiles x where x.id = u.id)) as 缺好日子,
       (select count(*) from auth.users u where not exists (select 1 from public.profiles x where x.id = u.id))
     + (select count(*) from auth.users u where not exists (select 1 from happyhands.profiles x where x.id = u.id))
     + (select count(*) from auth.users u where not exists (select 1 from gooddays.profiles x where x.id = u.id)) = 0 as ok;

\echo '=== 6. 真的註冊一個帳號：三個 trigger 都要跑到，而且任何一站壞掉都不能擋住註冊 ==='
begin;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '11111111-2222-3333-4444-555555555555', 'authenticated', 'authenticated',
        'trigger-drill@example.com', crypt('x', gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"扇出測試","name":"扇出測試"}'::jsonb, now(), now());
select '新帳號的 profile' as 檢查,
       (select count(*) from public.profiles where id = '11111111-2222-3333-4444-555555555555') as 小時光,
       (select count(*) from happyhands.profiles where id = '11111111-2222-3333-4444-555555555555') as 快樂手,
       (select count(*) from gooddays.profiles where id = '11111111-2222-3333-4444-555555555555') as 好日子,
       (select count(*) from public.profiles where id = '11111111-2222-3333-4444-555555555555')
     + (select count(*) from happyhands.profiles where id = '11111111-2222-3333-4444-555555555555')
     + (select count(*) from gooddays.profiles where id = '11111111-2222-3333-4444-555555555555') = 3 as ok;
select '快樂手的 full_name 有吃到 metadata' as 檢查,
       (select full_name from happyhands.profiles where id = '11111111-2222-3333-4444-555555555555') as 值,
       (select full_name from happyhands.profiles where id = '11111111-2222-3333-4444-555555555555') = '扇出測試' as ok;
rollback;   -- 🔴 一定要 rollback：這是驗證，不是真的要建帳號

\echo '=== 7. 一站的 trigger 壞掉時，另外兩站仍然註冊得了（exception 吞例外）==='
begin;
-- not valid 的 check 只檢查新列、不回頭驗既有的 46 列——正是「只讓 trigger 的 insert 失敗」要的效果。
-- 🔴 不可以再 validate constraint，那會去驗既有列而直接失敗。
alter table happyhands.profiles add constraint drill_always_fails check (false) not valid;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '99999999-8888-7777-6666-555555555555', 'authenticated', 'authenticated',
        'trigger-drill2@example.com', crypt('x', gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());
select '快樂手 trigger 壞掉時' as 情境,
       (select count(*) from auth.users where id = '99999999-8888-7777-6666-555555555555') as 帳號建得起來,
       (select count(*) from public.profiles where id = '99999999-8888-7777-6666-555555555555') as 小時光profile,
       (select count(*) from happyhands.profiles where id = '99999999-8888-7777-6666-555555555555') as 快樂手profile,
       (select count(*) from gooddays.profiles where id = '99999999-8888-7777-6666-555555555555') as 好日子profile,
       (select count(*) from auth.users where id = '99999999-8888-7777-6666-555555555555') = 1
   and (select count(*) from public.profiles where id = '99999999-8888-7777-6666-555555555555') = 1
   and (select count(*) from gooddays.profiles where id = '99999999-8888-7777-6666-555555555555') = 1
   and (select count(*) from happyhands.profiles where id = '99999999-8888-7777-6666-555555555555') = 0 as ok;
rollback;
