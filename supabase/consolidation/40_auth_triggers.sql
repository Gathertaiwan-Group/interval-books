-- 40_auth_triggers.sql — 三站共用 auth.users：把三個同名的 on_auth_user_created 改成三個各自獨立的 trigger
--
-- 為什麼「扇出」（每次註冊三個 schema 都建一列 profile）而不是「分派」：
--   raw_user_meta_data 是 client 可寫的；Dashboard 建帳號、admin.createUser（快樂手 provision.ts、
--   小時光 staff-accounts.ts）都不會帶站別；而好日子 orders.user_id FK、快樂手 lib/account/guard.ts
--   都假設 profile 存在——缺一列會讓那一站結帳或登入炸掉。每站都建一列最安全。
-- 為什麼每支都包 exception：三個 trigger 掛在同一張表，任一個 raise 會 abort 整個 insert，
--   一站的 schema bug 會讓三站都不能註冊（新的耦合）。這裡只 raise warning、一律 return new。
-- 原本各站的 handle_new_user() 函式保留、不掛 trigger（孤兒，無害）；別處若有呼叫也不會壞。

drop trigger if exists on_auth_user_created on auth.users;  -- 種子 dump 帶進來的小時光原版；10/20 已把另兩站的拿掉

-- ── 小時光（原 public.handle_new_user：只寫 id, email；role 走欄位預設 'customer'）──────────────
create or replace function public.interval_on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
exception when others then
  raise warning '[interval] profile fan-out failed for %: % (%)', new.id, sqlerrm, sqlstate;
  return new;
end $$;

-- ── 好日子（原 public.handle_new_user：id, email, name）───────────────────────────────────────
create or replace function gooddays.gooddays_on_auth_user_created() returns trigger
language plpgsql security definer set search_path = gooddays as $$
begin
  insert into gooddays.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
exception when others then
  raise warning '[gooddays] profile fan-out failed for %: % (%)', new.id, sqlerrm, sqlstate;
  return new;
end $$;

-- ── 快樂手（原 handle_new_user 最終版：full_name 三段 fallback ＋ staff_invites 一次性消費）──────
-- ⚠️ 合併後「帳號已存在」變常態（客人先在別站註冊），這裡的 staff_invites 只在「新帳號」時消費；
--    既有帳號要套邀請得在登入時另補一條路徑（見 plan「auth.users 合併」第 7 點）。
create or replace function happyhands.happyhands_on_auth_user_created() returns trigger
language plpgsql security definer set search_path = happyhands as $$
declare
  v_email  text;
  v_invite happyhands.staff_invites%rowtype;
begin
  v_email := lower(trim(new.email));
  insert into happyhands.profiles (id, full_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),      -- Google / LINE
      nullif(trim(new.raw_user_meta_data ->> 'nickname'), '')
    )
  )
  on conflict (id) do nothing;

  if v_email is not null and v_email <> '' then
    delete from happyhands.staff_invites where email = v_email returning * into v_invite;
    if found then
      update happyhands.profiles set role = v_invite.role where id = new.id;
    end if;
  end if;
  return new;
exception when others then
  raise warning '[happyhands] profile fan-out failed for %: % (%)', new.id, sqlerrm, sqlstate;
  return new;
end $$;

-- 三個 trigger 各掛各的；同一事件依名稱字母序執行（gooddays → happyhands → interval），順序無關緊要
create trigger gooddays_on_auth_user_created   after insert on auth.users for each row execute function gooddays.gooddays_on_auth_user_created();
create trigger happyhands_on_auth_user_created after insert on auth.users for each row execute function happyhands.happyhands_on_auth_user_created();
create trigger interval_on_auth_user_created   after insert on auth.users for each row execute function public.interval_on_auth_user_created();
