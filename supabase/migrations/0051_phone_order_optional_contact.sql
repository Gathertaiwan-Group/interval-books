-- 0051_phone_order_optional_contact.sql —— 後台電話報名：聯絡資料放寬＋事後補資料
--
-- 業主實際使用時卡住：接電話常常要不到完整資料（同行者沒有任何聯絡方式、訂購人只給
-- 手機）。規則改成**只對 source = 'admin_phone' 放寬**，前台結帳一個字不變：
--
--   · 訂購人：姓名必填；手機或 Email 至少一項（沒填的那一欄存空字串，customer_email／
--     customer_phone 仍是 NOT NULL —— 不放寬 NOT NULL，前台與所有讀這兩欄的程式碼
--     看到的型別不變）。
--   · 參加者：聯絡方式可以全空（姓名仍必填；空白時程式會自動帶「訂購人 同行者 N」）。
--   · 勾「寄信給客人」就一定要有 Email。
--
-- §1 event_registrations_contactable：CHECK → 觸發器。
--    CHECK 只看得到同一列，看不到這張報名屬於哪一種訂單，所以改成 before insert/update
--    觸發器：有 Email 或手機 → 照舊通過；兩者皆空 → 只有 order 的 source = 'admin_phone'
--    才放行，其餘一律以同一個名字（event_registrations_contactable、check_violation）拒絕，
--    前台訂單的行為與錯誤碼跟原本的 CHECK 一樣。
--    觸發器名字與舊 CHECK 同名，排查時搜得到。reserve_session_seat() 一個字沒動。
--
-- §2 orders 兩條 CHECK（只約束 admin_phone，前台訂單一律成立）：
--    orders_admin_phone_contact      電話報名的訂購人至少要有 Email 或手機
--    orders_admin_phone_notify_email 電話報名勾了寄信 → 一定要有 Email
--    正式庫目前 0 張 admin_phone 訂單（套用前已查），不需要 not valid。
--
-- §3 事後補資料：admin_update_phone_order_contacts()＋稽核表 order_contact_edit_log。
--    只能改 admin_phone 訂單的訂購人姓名／手機／Email 與這張單上參加者的姓名／手機／Email。
--    一個交易：鎖訂單列 → 驗全部輸入 → 才開始寫 → 有變動才寫一列稽核。
--    稽核記「誰、什麼時候、哪一張單、哪幾個欄位」，**不存新舊值**（同 0044
--    registration_removal_log 只存姓名首字的立場：稽核表不當第二份個資副本）。
--    格式（09 開頭 10 碼、Email 合法）在 server fn 的 zod 驗；這裡守住結構性規則。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 先套正式庫再推碼。舊程式碼在這支套用後照常運作（舊程式碼仍要求聯絡方式，只是不會
-- 用到放寬的部分）；新程式碼依賴 §1 與 §3，所以不可以早於這支上線。

begin;

-- ---------------------------------------------------------------------------
-- §1  參加者聯絡方式：CHECK → 觸發器（admin_phone 放行）
-- ---------------------------------------------------------------------------
create or replace function public.event_registrations_check_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if nullif(btrim(coalesce(new.email, '')), '') is not null
     or nullif(btrim(coalesce(new.phone, '')), '') is not null then
    return new;
  end if;
  if exists (
    select 1
      from public.orders o
     where o.id = new.order_id
       and o.source = 'admin_phone'
  ) then
    return new;
  end if;
  raise exception 'new row for relation "event_registrations" violates check constraint "event_registrations_contactable"'
    using errcode = 'check_violation',
          constraint = 'event_registrations_contactable',
          schema = 'public',
          table = 'event_registrations';
end;
$$;

revoke all on function public.event_registrations_check_contact() from public, anon, authenticated;

drop trigger if exists event_registrations_contactable on public.event_registrations;
create trigger event_registrations_contactable
  before insert or update of email, phone, order_id on public.event_registrations
  for each row execute function public.event_registrations_check_contact();

alter table public.event_registrations drop constraint if exists event_registrations_contactable;

-- ---------------------------------------------------------------------------
-- §2  orders：電話報名的訂購人聯絡方式
-- ---------------------------------------------------------------------------
alter table public.orders drop constraint if exists orders_admin_phone_contact;
alter table public.orders
  add constraint orders_admin_phone_contact check (
    source <> 'admin_phone'
    or nullif(btrim(customer_email), '') is not null
    or nullif(btrim(customer_phone), '') is not null
  );

alter table public.orders drop constraint if exists orders_admin_phone_notify_email;
alter table public.orders
  add constraint orders_admin_phone_notify_email check (
    source <> 'admin_phone'
    or not notify_customer
    or nullif(btrim(customer_email), '') is not null
  );

-- ---------------------------------------------------------------------------
-- §3  事後補資料：稽核表＋RPC
-- ---------------------------------------------------------------------------
create table if not exists public.order_contact_edit_log (
  id         bigint generated always as identity primary key,
  edited_at  timestamptz not null default now(),
  actor_id   uuid,
  order_id   uuid not null,
  -- {"customer":["email"],"participants":[{"registration_id":"…","seat_no":2,"fields":["name","phone"]}]}
  changes    jsonb not null
);

create index if not exists order_contact_edit_log_order_idx
  on public.order_contact_edit_log (order_id, edited_at desc);

alter table public.order_contact_edit_log enable row level security;

revoke all on table public.order_contact_edit_log from anon, authenticated;
revoke all on table public.order_contact_edit_log from service_role;
grant select on table public.order_contact_edit_log to service_role;

drop function if exists public.admin_update_phone_order_contacts(uuid, uuid, jsonb, jsonb);
create function public.admin_update_phone_order_contacts(
  p_order_id     uuid,
  p_actor_id     uuid,
  p_customer     jsonb,
  p_participants jsonb
)
returns table (
  updated boolean,
  reason  text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source     text;
  v_notify     boolean;
  v_old_name   text;
  v_old_email  text;
  v_old_phone  text;
  v_name       text;
  v_email      text;
  v_phone      text;
  v_cust       text[] := '{}';
  v_parts      jsonb := '[]'::jsonb;
  v_p          jsonb;
  v_reg_id     uuid;
  v_seat       integer;
  v_r_name     text;
  v_r_email    text;
  v_r_phone    text;
  v_n_name     text;
  v_n_email    text;
  v_n_phone    text;
  v_fields     text[];
begin
  if p_order_id is null or p_actor_id is null then
    raise exception 'MISSING_ARGUMENT' using errcode = 'check_violation';
  end if;
  if p_customer is null or jsonb_typeof(p_customer) <> 'object' then
    raise exception 'CUSTOMER_NOT_OBJECT' using errcode = 'check_violation';
  end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'PARTICIPANTS_NOT_ARRAY' using errcode = 'check_violation';
  end if;

  select o.source, o.notify_customer, o.customer_name, o.customer_email, o.customer_phone
    into v_source, v_notify, v_old_name, v_old_email, v_old_phone
    from public.orders o
   where o.id = p_order_id
     for update;
  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;
  if v_source is distinct from 'admin_phone' then
    return query select false, 'not_phone_order'::text;
    return;
  end if;

  -- ---- 先驗全部輸入，一個字都還沒寫 ----------------------------------------
  v_name  := btrim(coalesce(p_customer ->> 'name', ''));
  v_email := btrim(coalesce(p_customer ->> 'email', ''));
  v_phone := btrim(coalesce(p_customer ->> 'phone', ''));
  if v_name = '' then
    return query select false, 'customer_name_required'::text;
    return;
  end if;
  if v_email = '' and v_phone = '' then
    return query select false, 'customer_contact_required'::text;
    return;
  end if;
  if v_notify and v_email = '' then
    return query select false, 'email_required_for_notify'::text;
    return;
  end if;

  for v_p in select e.value from jsonb_array_elements(p_participants) as e(value) loop
    if jsonb_typeof(v_p) <> 'object' or coalesce(v_p ->> 'id', '') = '' then
      raise exception 'PARTICIPANT_INVALID' using errcode = 'check_violation';
    end if;
    -- 驗證的同時就鎖住這一列：0044 的「移除參加者」不鎖訂單列，沒鎖的話它可能在
    -- 驗證與寫入之間把這一列刪掉，寫入段就會對 NULL 記一筆不實的稽核。
    perform 1
      from public.event_registrations r
     where r.id = (v_p ->> 'id')::uuid
       and r.order_id = p_order_id
       for update;
    if not found then
      return query select false, 'registration_not_in_order'::text;
      return;
    end if;
    if btrim(coalesce(v_p ->> 'name', '')) = '' then
      return query select false, 'participant_name_required'::text;
      return;
    end if;
  end loop;

  -- ---- 訂購人 -------------------------------------------------------------
  if v_name is distinct from v_old_name then v_cust := v_cust || 'name'::text; end if;
  if v_email is distinct from btrim(coalesce(v_old_email, '')) then v_cust := v_cust || 'email'::text; end if;
  if v_phone is distinct from btrim(coalesce(v_old_phone, '')) then v_cust := v_cust || 'phone'::text; end if;
  if cardinality(v_cust) > 0 then
    update public.orders
       set customer_name  = v_name,
           customer_email = v_email,
           customer_phone = v_phone
     where id = p_order_id;
  end if;

  -- ---- 參加者 -------------------------------------------------------------
  for v_p in select e.value from jsonb_array_elements(p_participants) as e(value) loop
    select r.id, r.seat_no, r.name, r.email, r.phone
      into v_reg_id, v_seat, v_r_name, v_r_email, v_r_phone
      from public.event_registrations r
     where r.id = (v_p ->> 'id')::uuid
       and r.order_id = p_order_id
       for update;
    v_n_name  := btrim(coalesce(v_p ->> 'name', ''));
    v_n_email := nullif(btrim(coalesce(v_p ->> 'email', '')), '');
    v_n_phone := nullif(btrim(coalesce(v_p ->> 'phone', '')), '');
    v_fields := '{}';
    if v_n_name is distinct from v_r_name then v_fields := v_fields || 'name'::text; end if;
    if v_n_email is distinct from nullif(btrim(coalesce(v_r_email, '')), '') then
      v_fields := v_fields || 'email'::text;
    end if;
    if v_n_phone is distinct from nullif(btrim(coalesce(v_r_phone, '')), '') then
      v_fields := v_fields || 'phone'::text;
    end if;
    if cardinality(v_fields) > 0 then
      update public.event_registrations
         set name = v_n_name, email = v_n_email, phone = v_n_phone
       where id = v_reg_id;
      v_parts := v_parts || jsonb_build_array(jsonb_build_object(
        'registration_id', v_reg_id, 'seat_no', v_seat, 'fields', to_jsonb(v_fields)));
    end if;
  end loop;

  if cardinality(v_cust) = 0 and jsonb_array_length(v_parts) = 0 then
    return query select true, 'unchanged'::text;
    return;
  end if;

  insert into public.order_contact_edit_log (actor_id, order_id, changes)
  values (
    p_actor_id,
    p_order_id,
    jsonb_build_object('customer', to_jsonb(v_cust), 'participants', v_parts)
  );

  return query select true, 'updated'::text;
end;
$$;

revoke all on function public.admin_update_phone_order_contacts(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_update_phone_order_contacts(uuid, uuid, jsonb, jsonb)
  to service_role;

commit;
