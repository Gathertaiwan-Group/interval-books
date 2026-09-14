-- 由 rewrite_schema.py 自動產生，不要手改；改規則請改產生器。
create schema if not exists happyhands;
grant usage on schema happyhands to service_role, anon, authenticated;
alter default privileges in schema happyhands grant all on tables to service_role;
alter default privileges in schema happyhands grant all on sequences to service_role;
alter default privileges in schema happyhands grant all on functions to service_role;


-- ===== 20260808000001_init.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 HAPPY HEALING HANDS — 初始 schema
-- 來源規格：design_handoff_happyhands/STACK.md §3、apps/web/lib/content.ts、
--            apps/web/lib/data.ts（查詢層欄位需求）
--
-- 設計原則
--   1. 全部物件建在 public schema，PostgREST 才讀得到。
--   2. 所有語句都寫成可重複執行（if not exists / or replace），
--      方便在 shadow DB 或重跑 migration 時不會爆。
--   3. 金額一律 int（新台幣元，不用小數）。
--   4. RLS 與授權集中在下一個 migration（..._rls.sql），本檔只管結構。
-- =============================================================================

-- gen_random_uuid() 在 PG 13+ 已內建於 core；此處只是保險，
-- Supabase 專案本來就把 pgcrypto 裝在 extensions schema。
do $$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  raise notice '略過 pgcrypto 安裝：%', sqlerrm;
end $$;


-- -----------------------------------------------------------------------------
-- 0. 型別
-- -----------------------------------------------------------------------------

-- STACK.md 原本只寫 course / workshop，但 CONTENT.md 有「24 節氣年度陪伴計畫」
-- 這種訂閱制商品，lib/content.ts 的 ProductType 也是三種，因此 enum 補上 subscription。
do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'product_type' and n.nspname = 'public'
  ) then
    create type happyhands.product_type as enum ('course', 'workshop', 'subscription');
  end if;
end $$;

-- 若這個 DB 之前已經照 STACK.md 建過只有兩個值的 enum，補進第三個值。
-- （同一個 transaction 內剛建立的 enum 不能 add value，所以要吃掉例外。）
do $$
begin
  alter type happyhands.product_type add value if not exists 'subscription';
exception when others then
  raise notice '略過 product_type 補值：%', sqlerrm;
end $$;


-- -----------------------------------------------------------------------------
-- 1. 共用 trigger function
-- -----------------------------------------------------------------------------

-- updated_at 自動維護。刻意自寫而不依賴 moddatetime extension，
-- 免得不同 Supabase 專案的 extensions schema search_path 不一致。
create or replace function happyhands.set_updated_at()
returns trigger
language plpgsql
set search_path = happyhands
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function happyhands.set_updated_at() is
  '每張表的 before update trigger，統一維護 updated_at。';


-- -----------------------------------------------------------------------------
-- 2. profiles — auth.users 的延伸資料
-- -----------------------------------------------------------------------------

create table if not exists happyhands.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text,
  phone       text,
  birth_year  int,
  line_user_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_birth_year_range
    check (birth_year is null or birth_year between 1900 and 2100)
);

comment on table happyhands.profiles is
  '會員延伸資料。主鍵即 auth.users.id，RLS 用 auth.uid() = id 判斷。';


-- -----------------------------------------------------------------------------
-- 3. products — 線上課 / 工作坊 / 訂閱 共用
-- -----------------------------------------------------------------------------

create table if not exists happyhands.products (
  id               uuid primary key default gen_random_uuid(),
  type             happyhands.product_type not null,
  slug             text not null,
  title            text not null,
  subtitle         text,
  description      text,
  price            int not null,
  compare_at_price int,                      -- 原價（劃線顯示），null = 不顯示
  cover_url        text,
  is_published     boolean not null default false,
  is_featured      boolean not null default false,  -- 首頁主推卡片
  tags             text[] not null default '{}',    -- 例：{線上課程,含課本}
  benefits         text[] not null default '{}',    -- 例：{永久回放,含紙本課本}
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- slug 唯一，同時提供 products(slug) 的 btree 索引（見 §11 索引說明）
  constraint products_slug_key unique (slug),
  constraint products_price_nonneg check (price >= 0),
  constraint products_compare_at_price_sane
    check (compare_at_price is null or compare_at_price >= price)
);

comment on table happyhands.products is
  '商品主檔。type 涵蓋線上課 / 實體工作坊 / 訂閱制；未發布（is_published = false）者 anon 讀不到。';
comment on column happyhands.products.is_featured is
  'lib/data.ts mapProduct() 讀這欄餵給前端的 featured。';
comment on column happyhands.products.tags is
  '前端 Pill 標籤，內容需與 lib/content.ts 的 tags 一致。';
comment on column happyhands.products.compare_at_price is
  '劃線原價，語意上必須 >= price，因此加了 check 防止填反。';


-- -----------------------------------------------------------------------------
-- 4. course_lessons — 線上課單元
-- -----------------------------------------------------------------------------

create table if not exists happyhands.course_lessons (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references happyhands.products (id) on delete cascade,
  title        text not null,
  duration_sec int,
  video_path   text,                        -- Supabase Storage 私有路徑，不是可直接播放的 URL
  free_preview boolean not null default false,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 同一門課裡 sort_order 唯一：seed 靠這組當 on conflict 目標，
  -- 同時提供 course_lessons(product_id, sort_order) 的複合索引。
  constraint course_lessons_product_sort_key unique (product_id, sort_order),
  constraint course_lessons_duration_nonneg
    check (duration_sec is null or duration_sec >= 0)
);

comment on table happyhands.course_lessons is
  '線上課單元。lib/data.ts 用 products.select("*, course_lessons(*)") 內嵌讀取，並依 sort_order 排序。';
comment on column happyhands.course_lessons.video_path is
  '私有 bucket 內的物件路徑。取得路徑本身不等於可播放，播放一律由 server 查 entitlements 後簽 2 小時 URL。';


-- -----------------------------------------------------------------------------
-- 5. workshop_sessions — 工作坊場次
-- -----------------------------------------------------------------------------

create table if not exists happyhands.workshop_sessions (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references happyhands.products (id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  location    text,
  address     text,
  capacity    int not null,
  seats_taken int not null default 0,
  status      text not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 同一商品同一開始時間只會有一場：seed 的 on conflict 目標，
  -- 同時提供 workshop_sessions(product_id, starts_at) 的複合索引。
  constraint workshop_sessions_product_starts_key unique (product_id, starts_at),
  constraint workshop_sessions_status_valid
    check (status in ('open', 'full', 'closed', 'cancelled')),
  constraint workshop_sessions_time_valid check (ends_at > starts_at),
  constraint workshop_sessions_capacity_nonneg check (capacity >= 0),
  constraint workshop_sessions_seats_nonneg check (seats_taken >= 0),
  -- 最後一道防超賣：就算應用層寫錯，DB 也不允許 seats_taken 超過 capacity。
  constraint workshop_sessions_not_oversold check (seats_taken <= capacity)
);

comment on table happyhands.workshop_sessions is
  '工作坊場次。注意 product_id 沒有限定 type = workshop：「讀脈入門課」是線上課但另開台北實體班，CONTENT.md 明列此情形。';
comment on column happyhands.workshop_sessions.status is
  'open | full | closed | cancelled。open/full 由 trigger 依 seats_taken 自動維護；closed/cancelled 是人工狀態，trigger 不會覆蓋。';
comment on column happyhands.workshop_sessions.seats_taken is
  '含 15 分鐘暫扣（seat_holds）在內的已佔用名額。只能透過 reserve_seat() / release_expired_seat_holds() 等函式異動。';

-- status 自動維護：seats_taken >= capacity 時為 full，否則 open。
create or replace function happyhands.sync_workshop_session_status()
returns trigger
language plpgsql
set search_path = happyhands
as $$
begin
  -- closed / cancelled 是營運人員手動下的決定，不自動改回 open。
  if new.status in ('open', 'full') then
    if new.seats_taken >= new.capacity then
      new.status := 'full';
    else
      new.status := 'open';
    end if;
  end if;
  return new;
end;
$$;

comment on function happyhands.sync_workshop_session_status() is
  '依 seats_taken / capacity 自動維護 workshop_sessions.status 的 open/full 切換。';


-- -----------------------------------------------------------------------------
-- 6. orders / order_items
-- -----------------------------------------------------------------------------

create table if not exists happyhands.orders (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users (id) on delete set null,
  order_no         text not null,             -- HH-YYYYMMDD-XXXX
  status           text not null default 'pending',
  payment_method   text,                      -- credit | atm | manual
  total            int not null,

  -- 結帳表單欄位（結帳 API 寫入）
  contact_name     text,
  contact_phone    text,
  contact_email    text,
  shipping_address text,                      -- 含紙本課本的商品要寄送
  note             text,

  -- 結帳當下無法用 server 端商品定價核對總額時標記為 true，
  -- 出貨 / 開通前必須人工複核，避免前端傳來的金額被信任。
  price_unverified boolean not null default false,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  paid_at          timestamptz,

  constraint orders_order_no_key unique (order_no),
  constraint orders_status_valid
    check (status in ('pending', 'paid', 'cancelled', 'refunded')),
  constraint orders_payment_method_valid
    check (payment_method is null or payment_method in ('credit', 'atm', 'manual')),
  constraint orders_total_nonneg check (total >= 0),
  -- 只強制「已付款必須有付款時間」。cancelled / refunded 的訂單可能保留 paid_at
  -- （曾經付過再退），所以不做雙向等價檢查。
  constraint orders_paid_at_required_when_paid
    check (status <> 'paid' or paid_at is not null)
);

comment on table happyhands.orders is
  '訂單。user_id 可為 null，用於電話 / LINE 代訂（由客服以 service role 建立）。';
comment on column happyhands.orders.price_unverified is
  '金額未經 server 端定價核對的旗標。true 代表需人工複核後才能開通 entitlements。';
comment on column happyhands.orders.user_id is
  '會員刪除帳號時設為 null 而非連帶刪除訂單，保留帳務紀錄；null 的訂單只有 service role 讀得到。';

create table if not exists happyhands.order_items (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references happyhands.orders (id) on delete cascade,
  product_id uuid references happyhands.products (id) on delete restrict,
  session_id uuid references happyhands.workshop_sessions (id) on delete set null,
  unit_price int not null,
  qty        int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint order_items_unit_price_nonneg check (unit_price >= 0),
  constraint order_items_qty_positive check (qty > 0)
);

comment on table happyhands.order_items is
  '訂單明細。session_id 只有工作坊才有值。product_id 用 on delete restrict，避免刪商品把歷史訂單洗掉。';


-- -----------------------------------------------------------------------------
-- 7. entitlements — 觀看權限
-- -----------------------------------------------------------------------------

create table if not exists happyhands.entitlements (
  user_id    uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references happyhands.products (id) on delete cascade,
  order_id   uuid references happyhands.orders (id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,                    -- null = 永久回放
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

comment on table happyhands.entitlements is
  '觀看權限。只能由付款 webhook / 客服以 service role 寫入；使用者本人僅可讀取（可寫 = 可以免費開通自己）。';
comment on column happyhands.entitlements.order_id is
  '來源訂單，退款時方便反查要撤銷哪一筆權限。';


-- -----------------------------------------------------------------------------
-- 8. lesson_progress — 觀看進度
-- -----------------------------------------------------------------------------

create table if not exists happyhands.lesson_progress (
  user_id      uuid not null references auth.users (id) on delete cascade,
  lesson_id    uuid not null references happyhands.course_lessons (id) on delete cascade,
  position_sec int not null default 0,
  completed    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, lesson_id),
  constraint lesson_progress_position_nonneg check (position_sec >= 0)
);

comment on table happyhands.lesson_progress is
  '影片觀看進度，「我的課程」頁面用。使用者只能讀寫自己的列。';


-- -----------------------------------------------------------------------------
-- 9. seat_holds — 名額暫扣 15 分鐘
-- -----------------------------------------------------------------------------

create table if not exists happyhands.seat_holds (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references happyhands.workshop_sessions (id) on delete cascade,
  user_id    uuid references auth.users (id) on delete cascade,
  order_id   uuid references happyhands.orders (id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table happyhands.seat_holds is
  '下單即暫扣 15 分鐘的名額。一律透過 reserve_seat() 建立，不開放直接 insert（直接 insert 會繞過容量檢查）。';


-- -----------------------------------------------------------------------------
-- 10. Triggers
-- -----------------------------------------------------------------------------

-- updated_at
drop trigger if exists trg_profiles_updated_at on happyhands.profiles;
create trigger trg_profiles_updated_at
  before update on happyhands.profiles
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_products_updated_at on happyhands.products;
create trigger trg_products_updated_at
  before update on happyhands.products
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_course_lessons_updated_at on happyhands.course_lessons;
create trigger trg_course_lessons_updated_at
  before update on happyhands.course_lessons
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_workshop_sessions_updated_at on happyhands.workshop_sessions;
create trigger trg_workshop_sessions_updated_at
  before update on happyhands.workshop_sessions
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_orders_updated_at on happyhands.orders;
create trigger trg_orders_updated_at
  before update on happyhands.orders
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_order_items_updated_at on happyhands.order_items;
create trigger trg_order_items_updated_at
  before update on happyhands.order_items
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_entitlements_updated_at on happyhands.entitlements;
create trigger trg_entitlements_updated_at
  before update on happyhands.entitlements
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_lesson_progress_updated_at on happyhands.lesson_progress;
create trigger trg_lesson_progress_updated_at
  before update on happyhands.lesson_progress
  for each row execute function happyhands.set_updated_at();

drop trigger if exists trg_seat_holds_updated_at on happyhands.seat_holds;
create trigger trg_seat_holds_updated_at
  before update on happyhands.seat_holds
  for each row execute function happyhands.set_updated_at();

-- workshop_sessions.status 自動維護（insert 與 update 都要，seed 進來就會直接算好）
drop trigger if exists trg_workshop_sessions_status on happyhands.workshop_sessions;
create trigger trg_workshop_sessions_status
  before insert or update on happyhands.workshop_sessions
  for each row execute function happyhands.sync_workshop_session_status();


-- -----------------------------------------------------------------------------
-- 11. 索引
--
-- 說明：規格要求的 products(slug)、workshop_sessions(product_id, starts_at)、
-- entitlements(user_id) 這三個索引，已經分別由 unique constraint
-- products_slug_key、workshop_sessions_product_starts_key 以及
-- entitlements 的 primary key (user_id, product_id)（前導欄位就是 user_id）提供。
-- 重複建立同鍵索引只會增加寫入放大與 bloat，不會加快查詢，因此這裡不重複建，
-- 改為補上實際查詢真正需要、而 constraint 沒有覆蓋到的索引。
-- -----------------------------------------------------------------------------

-- 規格指定的複合索引（type + is_published + sort_order）
create index if not exists idx_products_type_published_sort
  on happyhands.products (type, is_published, sort_order);

-- lib/data.ts getProducts()：where is_published order by sort_order（沒有 type 條件），
-- 用 partial index 直接命中，且只索引已發布的列。
create index if not exists idx_products_published_sort
  on happyhands.products (sort_order, id)
  where is_published;

-- lib/data.ts getWorkshopSessions()：status in ('open','full') order by starts_at
create index if not exists idx_workshop_sessions_open_starts_at
  on happyhands.workshop_sessions (starts_at)
  where status in ('open', 'full');

create index if not exists idx_orders_user_created_at
  on happyhands.orders (user_id, created_at desc);

create index if not exists idx_order_items_order_id
  on happyhands.order_items (order_id);

-- FK 反查用（刪除商品 / 場次時避免全表掃描）
create index if not exists idx_order_items_product_id
  on happyhands.order_items (product_id);

create index if not exists idx_order_items_session_id
  on happyhands.order_items (session_id)
  where session_id is not null;

create index if not exists idx_entitlements_product_id
  on happyhands.entitlements (product_id);

create index if not exists idx_entitlements_order_id
  on happyhands.entitlements (order_id)
  where order_id is not null;

-- lesson_progress 主鍵前導欄是 user_id，lesson_id 需要自己的索引供 FK cascade 使用
create index if not exists idx_lesson_progress_lesson_id
  on happyhands.lesson_progress (lesson_id);

-- Railway worker 每分鐘掃過期暫扣
create index if not exists idx_seat_holds_expires_at
  on happyhands.seat_holds (expires_at);

create index if not exists idx_seat_holds_session_id
  on happyhands.seat_holds (session_id);

create index if not exists idx_seat_holds_user_id
  on happyhands.seat_holds (user_id)
  where user_id is not null;

create index if not exists idx_seat_holds_order_id
  on happyhands.seat_holds (order_id)
  where order_id is not null;


-- =============================================================================
-- 12. 名額管理函式（防超賣）
--
-- 鎖定策略（兩個函式必須一致，否則會 deadlock）：
--   永遠先 `select ... for update` 鎖住 workshop_sessions 那一列，
--   再去動同一場次的 seat_holds。
--   reserve_seat() 一次只鎖一場；release_expired_seat_holds() 依 session_id 排序
--   逐場鎖定，兩者取鎖順序相同，不會互相等待。
--
-- 錯誤碼採 PostgREST 的 PTxxx 慣例（最後三碼即 HTTP status）；
-- 若 PostgREST 版本不支援則退化為 500，但訊息仍會原樣回傳。
-- =============================================================================

create or replace function happyhands.reserve_seat(p_session_id uuid, p_user_id uuid)
returns happyhands.seat_holds
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_session   happyhands.workshop_sessions;
  v_hold      happyhands.seat_holds;
  v_reclaimed int;
begin
  -- 不允許替別人保留名額。service role 呼叫時 auth.uid() 為 null，
  -- 所以客服代訂（帶任意 user_id）仍然可行。
  if auth.uid() is not null and p_user_id is distinct from auth.uid() then
    raise exception '不可替其他使用者保留名額' using errcode = 'PT403';
  end if;

  -- (1) 先鎖住場次列。同場次的併發報名到這裡就被序列化了。
  select * into v_session
  from happyhands.workshop_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception '找不到這個場次' using errcode = 'PT404';
  end if;

  -- (2) 鎖到之後才回收這一場的過期暫扣，避免 worker 還沒跑到就誤判額滿。
  --     順序（先鎖 session 再動 seat_holds）與 release_expired_seat_holds() 一致。
  with expired as (
    delete from happyhands.seat_holds
    where session_id = p_session_id
      and expires_at <= now()
    returning 1
  )
  select count(*)::int into v_reclaimed from expired;

  if v_reclaimed > 0 then
    update happyhands.workshop_sessions
    set seats_taken = greatest(seats_taken - v_reclaimed, 0)
    where id = p_session_id
    returning * into v_session;   -- 讓本地變數跟上最新值
  end if;

  -- (3) 狀態與容量檢查
  if v_session.status in ('closed', 'cancelled') then
    raise exception '這個場次已經停止報名' using errcode = 'PT409';
  end if;

  if v_session.seats_taken >= v_session.capacity then
    raise exception '這個場次已經額滿' using errcode = 'PT409';
  end if;

  -- (4) 建立 15 分鐘暫扣並佔用名額
  insert into happyhands.seat_holds (session_id, user_id, expires_at)
  values (p_session_id, p_user_id, now() + interval '15 minutes')
  returning * into v_hold;

  update happyhands.workshop_sessions
  set seats_taken = seats_taken + 1
  where id = p_session_id;
  -- status 由 trg_workshop_sessions_status 自動轉成 full

  return v_hold;
end;
$$;

comment on function happyhands.reserve_seat(uuid, uuid) is
  '工作坊名額暫扣 15 分鐘。以 select ... for update 鎖住場次列序列化併發報名，額滿丟 PT409 例外。';


create or replace function happyhands.release_expired_seat_holds()
returns int
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_session_id uuid;
  v_released   int;
  v_total      int := 0;
begin
  -- 依 session_id 排序逐場處理，並維持「先鎖 session 再動 seat_holds」的取鎖順序，
  -- 與 reserve_seat() 一致，避免 deadlock。整個迴圈在同一個 transaction 內完成。
  for v_session_id in
    select distinct session_id
    from happyhands.seat_holds
    where expires_at <= now()
    order by session_id
  loop
    perform 1 from happyhands.workshop_sessions where id = v_session_id for update;

    with expired as (
      delete from happyhands.seat_holds
      where session_id = v_session_id
        and expires_at <= now()
      returning 1
    )
    select count(*)::int into v_released from expired;

    if v_released > 0 then
      update happyhands.workshop_sessions
      set seats_taken = greatest(seats_taken - v_released, 0)
      where id = v_session_id;
      v_total := v_total + v_released;
    end if;
  end loop;

  return v_total;
end;
$$;

comment on function happyhands.release_expired_seat_holds() is
  'Railway worker 每分鐘呼叫：刪除過期 seat_holds 並把 seats_taken 減回去，回傳釋放的名額數。';


-- --- 以下兩個是把名額生命週期補完整的小工具（規格未列，但結帳流程需要）-------
-- 沒有它們的話，寫結帳 API 的人只能自己下 update，很容易把 seats_taken 算錯。

-- 付款成功：暫扣轉為正式佔位。刪掉 hold 但「不」把 seats_taken 減回去。
create or replace function happyhands.commit_seat_hold(p_hold_id uuid)
returns boolean
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_session_id uuid;
begin
  select session_id into v_session_id from happyhands.seat_holds where id = p_hold_id;
  if not found then
    return false;   -- 已經被回收或已 commit，視為 no-op
  end if;

  perform 1 from happyhands.workshop_sessions where id = v_session_id for update;
  delete from happyhands.seat_holds where id = p_hold_id;
  return true;
end;
$$;

comment on function happyhands.commit_seat_hold(uuid) is
  '付款成功後把暫扣轉為正式佔位：刪除 seat_holds 但保留 seats_taken。';

-- 主動取消：刪掉 hold 並把 seats_taken 減回去。
create or replace function happyhands.release_seat_hold(p_hold_id uuid)
returns boolean
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_session_id uuid;
  v_deleted    int;
begin
  select session_id into v_session_id from happyhands.seat_holds where id = p_hold_id;
  if not found then
    return false;
  end if;

  perform 1 from happyhands.workshop_sessions where id = v_session_id for update;

  delete from happyhands.seat_holds where id = p_hold_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    update happyhands.workshop_sessions
    set seats_taken = greatest(seats_taken - v_deleted, 0)
    where id = v_session_id;
  end if;

  return v_deleted > 0;
end;
$$;

comment on function happyhands.release_seat_hold(uuid) is
  '使用者放棄結帳時主動釋放暫扣：刪除 seat_holds 並把 seats_taken 減回去。';
-- ===== 20260808000002_rls.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 — Row Level Security 與授權
-- 規格：design_handoff_happyhands/STACK.md §3「RLS 要點」
--
-- 授權模型（兩層，缺一不可）
--   第一層 GRANT：先 revoke all，再逐表 grant 最小必要權限。
--                 沒有 GRANT 的話，policy 寫得再好也進不來。
--   第二層 POLICY：每一張表都 enable row level security，
--                 包含「完全不開放給 anon/authenticated」的表也要開，
--                 漏開 RLS = 只要有 GRANT 就整表外洩。
--
-- 沒有 policy 的表 = 只有 service role（bypassrls）進得去，這是刻意的。
--
-- 注意：這裡刻意「不」使用 `force row level security`。
--       service_role 靠 bypassrls 屬性繞過 RLS，force 影響不到它；
--       但 force 會連 table owner（跑 migration / seed 的 postgres）都擋住，
--       會直接讓下一個 seed migration 失敗。
--
-- 效能小抄：policy 內的 auth.uid() 一律寫成 (select auth.uid())，
--          讓 planner 當成 InitPlan 只算一次，而不是每一列都呼叫。
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. 先收回所有預設權限
-- -----------------------------------------------------------------------------

revoke all on all tables in schema happyhands from anon, authenticated;
revoke all on all sequences in schema happyhands from anon, authenticated;
revoke all on all functions in schema happyhands from anon, authenticated;

-- 之後新增的物件也不要自動 grant。
-- ⚠️ 提醒後續開發者：新建表之後若出現 "permission denied for table xxx"，
--    就是這行造成的，正確做法是在該表的 migration 裡明確寫 grant，而不是把這行拿掉。
alter default privileges in schema happyhands revoke all on tables from anon, authenticated;
alter default privileges in schema happyhands revoke all on sequences from anon, authenticated;

-- PostgREST 仍需要 schema usage
grant usage on schema happyhands to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 1. 每一張表都開 RLS（包含沒有 policy 的）
-- -----------------------------------------------------------------------------

alter table happyhands.profiles          enable row level security;
alter table happyhands.products          enable row level security;
alter table happyhands.course_lessons    enable row level security;
alter table happyhands.workshop_sessions enable row level security;
alter table happyhands.orders            enable row level security;
alter table happyhands.order_items       enable row level security;
alter table happyhands.entitlements      enable row level security;
alter table happyhands.lesson_progress   enable row level security;
alter table happyhands.seat_holds        enable row level security;


-- =============================================================================
-- 2. 公開目錄：products / course_lessons / workshop_sessions
--    anon 與 authenticated 都只能 select，且只看得到已發布的商品。
--    任何寫入都不開放（service role 專用）。
-- =============================================================================

-- --- products ---------------------------------------------------------------
grant select on happyhands.products to anon, authenticated;

drop policy if exists "products_select_published" on happyhands.products;
create policy "products_select_published"
  on happyhands.products
  for select
  to anon, authenticated
  using (is_published = true);

-- --- course_lessons ----------------------------------------------------------
-- ⚠️ 這裡是 table 層 grant 而不是 column 層 grant，因為 lib/data.ts 用的是
--    products.select("*, course_lessons(*)")，PostgREST 會把 * 展開成全部欄位，
--    只要有一欄沒 grant 就整個查詢 permission denied。
--    代價是 video_path 會被未購買者讀到（只是私有 bucket 內的路徑字串，
--    沒有簽名 URL 無法播放）。若日後要徹底遮蔽，建議把 video_path 搬到
--    另一張不開放 anon 的 lesson_assets 表，前端查詢不需改動。
grant select on happyhands.course_lessons to anon, authenticated;

drop policy if exists "course_lessons_select_published_product" on happyhands.course_lessons;
create policy "course_lessons_select_published_product"
  on happyhands.course_lessons
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from happyhands.products p
      where p.id = course_lessons.product_id
        and p.is_published = true
    )
  );

-- --- workshop_sessions -------------------------------------------------------
grant select on happyhands.workshop_sessions to anon, authenticated;

drop policy if exists "workshop_sessions_select_published_product" on happyhands.workshop_sessions;
create policy "workshop_sessions_select_published_product"
  on happyhands.workshop_sessions
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from happyhands.products p
      where p.id = workshop_sessions.product_id
        and p.is_published = true
    )
  );


-- =============================================================================
-- 3. 個人資料：auth.uid() = user_id 才可讀寫
-- =============================================================================

-- --- profiles（主鍵就是 user id）---------------------------------------------
grant select, insert, update on happyhands.profiles to authenticated;

drop policy if exists "profiles_select_own" on happyhands.profiles;
create policy "profiles_select_own"
  on happyhands.profiles for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles_insert_own" on happyhands.profiles;
create policy "profiles_insert_own"
  on happyhands.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on happyhands.profiles;
create policy "profiles_update_own"
  on happyhands.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
-- 不開放 delete：刪帳號走 auth.users 的 cascade（service role）。


-- --- orders ------------------------------------------------------------------
-- ⚠️ 刻意「不」開放 update / delete。
--    orders.status 若使用者可改，任何人都能把自己的訂單改成 paid。
--    狀態流轉（pending → paid / cancelled / refunded）與 paid_at、total
--    一律只能由付款 webhook 或客服以 service role 寫入。
grant select, insert on happyhands.orders to authenticated;

drop policy if exists "orders_select_own" on happyhands.orders;
create policy "orders_select_own"
  on happyhands.orders for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "orders_insert_own_pending" on happyhands.orders;
create policy "orders_insert_own_pending"
  on happyhands.orders for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and status = 'pending'
    and paid_at is null
  );

-- --- order_items（透過 orders 關聯判斷擁有者）--------------------------------
grant select, insert on happyhands.order_items to authenticated;

drop policy if exists "order_items_select_own_order" on happyhands.order_items;
create policy "order_items_select_own_order"
  on happyhands.order_items for select to authenticated
  using (
    exists (
      select 1
      from happyhands.orders o
      where o.id = order_items.order_id
        and o.user_id = (select auth.uid())
    )
  );

drop policy if exists "order_items_insert_own_pending_order" on happyhands.order_items;
create policy "order_items_insert_own_pending_order"
  on happyhands.order_items for insert to authenticated
  with check (
    exists (
      select 1
      from happyhands.orders o
      where o.id = order_items.order_id
        and o.user_id = (select auth.uid())
        and o.status = 'pending'
    )
  );

-- --- entitlements ------------------------------------------------------------
-- ⚠️ 只給 select。可寫 = 使用者可以自己開通任何課程，等於全站付費內容免費。
--    發放一律由付款 webhook（service role）處理。
grant select on happyhands.entitlements to authenticated;

drop policy if exists "entitlements_select_own" on happyhands.entitlements;
create policy "entitlements_select_own"
  on happyhands.entitlements for select to authenticated
  using ((select auth.uid()) = user_id);

-- --- lesson_progress ---------------------------------------------------------
grant select, insert, update on happyhands.lesson_progress to authenticated;

drop policy if exists "lesson_progress_select_own" on happyhands.lesson_progress;
create policy "lesson_progress_select_own"
  on happyhands.lesson_progress for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "lesson_progress_insert_own" on happyhands.lesson_progress;
create policy "lesson_progress_insert_own"
  on happyhands.lesson_progress for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "lesson_progress_update_own" on happyhands.lesson_progress;
create policy "lesson_progress_update_own"
  on happyhands.lesson_progress for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- --- seat_holds --------------------------------------------------------------
-- ⚠️ 只給 select。直接 insert 會繞過 reserve_seat() 的容量檢查造成超賣，
--    所以建立暫扣一律走 reserve_seat() RPC（security definer）。
grant select on happyhands.seat_holds to authenticated;

drop policy if exists "seat_holds_select_own" on happyhands.seat_holds;
create policy "seat_holds_select_own"
  on happyhands.seat_holds for select to authenticated
  using ((select auth.uid()) = user_id);


-- =============================================================================
-- 4. 函式執行權限
--    注意：function 的 EXECUTE 預設會 grant 給 PUBLIC，
--    只 revoke anon/authenticated 是不夠的，必須連 public 一起收回。
-- =============================================================================

revoke all on function happyhands.reserve_seat(uuid, uuid) from public, anon, authenticated;
grant execute on function happyhands.reserve_seat(uuid, uuid) to authenticated, service_role;

revoke all on function happyhands.release_expired_seat_holds() from public, anon, authenticated;
grant execute on function happyhands.release_expired_seat_holds() to service_role;

revoke all on function happyhands.commit_seat_hold(uuid) from public, anon, authenticated;
grant execute on function happyhands.commit_seat_hold(uuid) to service_role;

revoke all on function happyhands.release_seat_hold(uuid) from public, anon, authenticated;
grant execute on function happyhands.release_seat_hold(uuid) to authenticated, service_role;

-- trigger function 不會被使用者直接呼叫（直接呼叫只會得到
-- "trigger functions can only be called as triggers"），trigger 執行時
-- 也不檢查 EXECUTE 權限，所以維持上面的 revoke all 即可。
revoke all on function happyhands.set_updated_at() from public;
revoke all on function happyhands.sync_workshop_session_status() from public;


-- =============================================================================
-- 5. 影片 Storage
--
-- ⚠️ 影片 bucket 一定要是 private（public = false）。
--    設成 public 等於把付費內容永久公開，而且 CDN 會快取，事後補救很麻煩。
--
-- 正確播放流程（STACK.md §3）：
--   1. 使用者點播放 → 打 server action / route handler（不是 client 直接要 URL）
--   2. server 用 service role 查 entitlements：
--        select 1 from entitlements
--        where user_id = <登入者> and product_id = <該課程>
--          and (expires_at is null or expires_at > now())
--      查不到就回 403，且不可以把 video_path 回傳給前端
--   3. 有權限才 createSignedUrl(video_path, 60 * 60 * 2)  ← 2 小時
--   4. free_preview = true 的單元可以不查 entitlements 直接簽，但仍然要走 server
--
-- 這裡刻意不新增任何 storage.objects 的 policy：
-- 沒有 policy 就只有 service role 讀得到 → 正好符合「一律由 server 簽 URL」。
-- =============================================================================

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('course-videos', 'course-videos', false)
  on conflict (id) do update set public = false;
exception when others then
  raise notice '略過 storage bucket 建立（權限不足或 storage schema 不存在）：%', sqlerrm;
end $$;
-- ===== 20260810000001_staff_roles.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 — 員工角色、邀請制與註冊時自動建檔
--
-- 這支 migration 做四件事，順序不可調換：
--   1. profiles 加 role 欄位
--   2. 把 role 從 authenticated 可寫的欄位裡拿掉（提權修補）
--   3. staff_invites：owner 邀請員工的一次性名單
--   4. handle_new_user()：註冊時建 profile，命中邀請就套用角色
--
-- ⚠️ 第 2 步必須跟第 1 步在同一支 migration。
--    分成兩支的話，中間那段時間線上就是可提權的狀態。
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. role 欄位
-- -----------------------------------------------------------------------------

alter table happyhands.profiles
  add column if not exists role text not null default 'customer';

-- 四個角色的意義（能力表的唯一真相在 apps/web/lib/admin/roles.ts，
-- 這裡只負責保證資料庫裡不會出現拼錯的值）：
--   customer 一般會員，進不了 /admin
--   support  客服：訂單、收款、名單、候補
--   editor   內容編輯：課程與工作坊，看不到訂單
--   owner    負責人：全部 + 員工管理 + 稽核
alter table happyhands.profiles
  drop constraint if exists profiles_role_valid;
alter table happyhands.profiles
  add constraint profiles_role_valid
  check (role in ('customer', 'support', 'editor', 'owner'));

-- 員工是極少數，用 partial index 讓 /admin/staff 的列表不用全表掃描。
create index if not exists idx_profiles_staff
  on happyhands.profiles (role)
  where role <> 'customer';

comment on column happyhands.profiles.role is
  '員工角色。只能由 service role 寫入（見本檔第 2 節的欄位級 grant）。';


-- -----------------------------------------------------------------------------
-- 2. 提權修補：把 role 從 authenticated 可寫的欄位裡拿掉
--
-- 原本 20260808000002_rls.sql:119 是 table 層的
--   grant select, insert, update on happyhands.profiles to authenticated;
-- 而 profiles_update_own / profiles_insert_own 兩個 policy 都只檢查
--   auth.uid() = id，沒有任何欄位限制。
--
-- 也就是說加了 role 欄位之後會有「兩條」提權路徑：
--   (a) update happyhands.profiles set role = 'owner' where id = auth.uid();
--   (b) insert 自己的 profile 時直接帶 role = 'owner';
--
-- policy 改不了這件事（policy 管的是「哪些列」，不是「哪些欄」）。
-- 正解是欄位級 GRANT —— 這也符合這份 schema 既有的哲學：
-- 「沒有 GRANT 的話，policy 寫得再好也進不來」。
-- -----------------------------------------------------------------------------

revoke insert, update on happyhands.profiles from authenticated;

-- insert 需要 id：profiles_insert_own 的 with check 是 auth.uid() = id，
-- 使用者必須寫得進 id 才建得了自己的 profile。
-- role 不在清單裡 → 只能吃 default 'customer'。
grant insert (id, full_name, phone, birth_year, line_user_id)
  on happyhands.profiles to authenticated;

grant update (full_name, phone, birth_year, line_user_id)
  on happyhands.profiles to authenticated;

-- select 維持 table 層：前台要讀自己的 role 來決定要不要顯示「後台」入口，
-- 而 profiles_select_own 已經限制只看得到自己那一列。


-- -----------------------------------------------------------------------------
-- 3. staff_invites — owner 邀請員工的一次性名單
--
-- 刻意不寫任何 grant：20260808000002_rls.sql 的 revoke all + alter default
-- privileges 讓新表預設就是 service-role-only，正好是這裡要的。
-- enable RLS 但不建 policy，是為了萬一日後有人補了 grant 也不會整表外洩。
-- -----------------------------------------------------------------------------

create table if not exists happyhands.staff_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  role        text not null,
  invited_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint staff_invites_role_valid
    check (role in ('support', 'editor', 'owner')),
  -- ⚠️ 這條 check 是必要的，不是潔癖。
  --    handle_new_user() 是拿 lower(trim(註冊者 email)) 去比對這裡的「原始值」，
  --    所以只要有人存進 'Staff@Example.com '，那封邀請就永遠不會被命中，
  --    而且不會有任何錯誤 —— 是一筆看得到卻永遠不生效的死邀請。
  --    寧可讓寫錯的 insert 當場報錯。
  --    順帶讓上面的 unique (email) 真的有意義：否則同一個人可以同時存在
  --    'Staff@Example.com' 與 'staff@example.com' 兩筆互相衝突的邀請。
  constraint staff_invites_email_normalized
    check (email = lower(trim(email)))
);

alter table happyhands.staff_invites enable row level security;

comment on table happyhands.staff_invites is
  '員工邀請名單。email 必須是 lower(trim()) 正規化後的值（由 check constraint 強制），'
  '被 handle_new_user() 消費一次後即刪除。只有 service role 進得去。';


-- -----------------------------------------------------------------------------
-- 4. handle_new_user() — 註冊時建 profile，命中邀請就套用角色
--
-- 為什麼要 trigger 而不是在應用層做：
--   註冊成功與建 profile 之間若有網路中斷，使用者會變成「有帳號沒 profile」，
--   之後每一頁都要處理這個半殘狀態。trigger 讓它在同一個 transaction 內完成。
--
-- security definer + 寫死 search_path：這支會以函式擁有者的權限執行，
-- 不鎖 search_path 的話有被 search_path 劫持的風險。
-- -----------------------------------------------------------------------------

create or replace function happyhands.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_email  text;
  v_invite happyhands.staff_invites%rowtype;
begin
  v_email := lower(trim(new.email));

  -- on conflict do nothing：使用者也可能自己先 insert 過（profiles_insert_own）
  insert into happyhands.profiles (id, full_name)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (id) do nothing;

  if v_email is null or v_email = '' then
    return new;
  end if;

  -- 一次性消費：select 之後就刪掉，同一封邀請不會被第二個人用掉
  delete from happyhands.staff_invites
  where email = v_email
  returning * into v_invite;

  if found then
    update happyhands.profiles
    set role = v_invite.role
    where id = new.id;
  end if;

  return new;
end;
$$;

-- 既有的 20260808000002_rls.sql:35-36 只 revoke 了 tables 與 sequences 的
-- default privileges，漏掉 functions。所以 rls.sql 之後新建的函式會自動繼承
-- Supabase 原廠給 anon/authenticated 的 EXECUTE。
-- handle_new_user() 是 trigger 函式（直呼會被 PostgreSQL 擋下）所以目前不可利用，
-- 但這個缺口會影響日後每一支新函式，在這裡一併補起來。
alter default privileges in schema happyhands
  revoke all on functions from anon, authenticated;

revoke all on function happyhands.handle_new_user()
  from public, anon, authenticated;

comment on function happyhands.handle_new_user() is
  '註冊時自動建 profile；email 命中 staff_invites 就套用該角色並刪除邀請。';
-- ===== 20260810000002_media_bucket.sql =====
set search_path = happyhands, public, extensions;

-- ===== 20260810000003_audit_log.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 — 後台操作稽核紀錄
--
-- 為什麼要有：多位員工 + 分權限 + 會碰訂單金額與付款狀態。
-- 沒有稽核就無法回答「誰把這筆 3,600 的訂單標成已收款」。
--
-- ⚠️ 刻意「不」用 DB trigger 做稽核。
--    後台一律以 service role 寫入，trigger 裡的 auth.uid() 是 null，
--    記出來的會是「有人改了某一列」而不是「王小明把 HH-… 標成已收款」，
--    對客服糾紛毫無用處。
--    改為應用層在每支 server action 成功後顯式呼叫 writeAudit()
--    （apps/web/lib/admin/audit.ts），由它帶入操作者身分。
--    代價：漏寫 writeAudit() 就沒紀錄，靠 code review 擋。
--
-- 刻意不寫任何 grant：revoke all + alter default privileges 讓新表
-- 預設就是 service-role-only，正好是這裡要的。
-- =============================================================================

create table if not exists happyhands.audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users(id) on delete set null,
  -- 冗餘存一份 email：帳號被刪之後仍然查得到是誰做的。
  actor_email text,
  actor_role  text,
  -- 動詞，例如 'order.mark_paid'、'product.publish'、'staff.invite'
  action      text not null,
  -- 受影響的實體種類與主鍵，例如 ('order', '<uuid>')
  entity      text not null,
  entity_id   text,
  -- 給人看的一句話，例如「把 HH-20260810-ABCD 標記為已收款」
  summary     text not null,
  -- 給機器看的前後值，只存有變動的欄位
  diff        jsonb,
  created_at  timestamptz not null default now()
);

alter table happyhands.audit_log enable row level security;

-- 稽核頁預設是「最近的在最上面」
create index if not exists idx_audit_log_created
  on happyhands.audit_log (created_at desc);

-- 「這筆訂單被動過哪些手腳」
create index if not exists idx_audit_log_entity
  on happyhands.audit_log (entity, entity_id, created_at desc);

comment on table happyhands.audit_log is
  '後台寫入操作的稽核紀錄。由 apps/web/lib/admin/audit.ts 的 writeAudit() 寫入，'
  '只有 service role 進得去。';
-- ===== 20260810000004_workshop_waitlist.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 — 工作坊候補名單
--
-- 這是「客服接完電話登記」用的，不是使用者自助排隊。
-- 前台額滿時的 CTA 就是 tel:0228335820（app/workshops/_components/session-row.tsx），
-- 客群 60–75 歲，打電話比填表單可靠。
--
-- 刻意不寫任何 grant → service-role-only。
-- =============================================================================

create table if not exists happyhands.workshop_waitlist (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references happyhands.workshop_sessions(id) on delete cascade,
  name        text not null,
  phone       text not null,
  email       text,
  note        text,
  -- waiting   還在等
  -- offered   已通知有位子，等對方回覆
  -- converted 已轉成正式報名（訂單另外建）
  -- cancelled 對方不要了 / 場次取消
  status      text not null default 'waiting',
  -- 哪位員工登記的
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint workshop_waitlist_status_valid
    check (status in ('waiting', 'offered', 'converted', 'cancelled'))
);

alter table happyhands.workshop_waitlist enable row level security;

-- 後台主要查詢：某一場的待處理候補，先登記的排前面
create index if not exists idx_waitlist_session
  on happyhands.workshop_waitlist (session_id, status, created_at);

-- 沿用既有的 updated_at trigger（20260808000001_init.sql:58）
drop trigger if exists set_updated_at_workshop_waitlist on happyhands.workshop_waitlist;
create trigger set_updated_at_workshop_waitlist
  before update on happyhands.workshop_waitlist
  for each row execute function happyhands.set_updated_at();

comment on table happyhands.workshop_waitlist is
  '工作坊候補名單，由客服在 /admin/sessions 手動登記。只有 service role 進得去。';
-- ===== 20260810000005_admin_seat_adjust.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 — 後台調整場次已報名人數
--
-- 為什麼要 RPC 而不是讓 server action 直接 update：
--   (1) seats_taken = seats_taken + 1 從 JS 端做要先 read 再 write，
--       兩個客服同時標記兩筆訂單付款就會少算一個。
--   (2) workshop_sessions 上有 check (seats_taken <= capacity)，
--       直接 update 撞到會丟 23514，server action 只能拿到一句英文錯誤。
--       在函式裡先 clamp 就能回傳「已經滿了」這種人話。
--
-- 取鎖順序刻意與 reserve_seat() 一致：先鎖 workshop_sessions 那一列，
-- 再動別的。順序一致才不會跟報名流程互等。
--
-- 只 grant execute 給 service_role —— 這支能無視名額上限往下扣，
-- 不是給前台用的。
-- =============================================================================

create or replace function happyhands.admin_adjust_seats(
  p_session_id uuid,
  p_delta      int
)
returns happyhands.workshop_sessions
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_session happyhands.workshop_sessions;
  v_target  int;
begin
  -- (1) 先鎖住場次列
  select * into v_session
  from happyhands.workshop_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception '找不到這個場次' using errcode = 'PT404';
  end if;

  -- (2) clamp 到 [0, capacity]，不讓 check constraint 有機會丟 23514。
  --     超出範圍不當成錯誤：客服手動微調時給個合理上下界比報錯好用。
  v_target := least(greatest(v_session.seats_taken + p_delta, 0), v_session.capacity);

  if v_target = v_session.seats_taken then
    return v_session;
  end if;

  update happyhands.workshop_sessions
  set seats_taken = v_target
  where id = p_session_id
  returning * into v_session;

  -- status 由 sync_workshop_session_status() trigger 自動維護
  -- （20260808000001_init.sql:197），這裡不用手動改。

  return v_session;
end;
$$;

revoke all on function happyhands.admin_adjust_seats(uuid, int) from public, anon, authenticated;
grant execute on function happyhands.admin_adjust_seats(uuid, int) to service_role;

comment on function happyhands.admin_adjust_seats(uuid, int) is
  '後台調整場次已報名人數，clamp 到 [0, capacity]。只有 service role 可執行。';
-- ===== 20260810000006_member_portal.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 學員會員中心：訂單歸戶、課程開通、寄信 outbox、YouTube 影片
-- =============================================================================
--
-- 這支解決的是一個結構性缺口：`orders.user_id` 從來沒有被寫過（全站訪客結帳），
-- 而 `entitlements.user_id` 是 NOT NULL 的主鍵前導欄 —— 也就是說在今天的資料
-- 模型下，「開通線上課程」這件事**物理上做不到**。按下「標記已收款」時，
-- 線上課程什麼都沒發生。
--
-- 補法是三段：
--   1. 下單時就用客人填的 Email 建帳號並綁 user_id（訪客結帳流程不變，不擋單）
--   2. 標記收款時由 grant_entitlements_for_order() 發放權限
--   3. 歷史訂單用 backfill / claim 兩支回填
--
-- 授權模型沿用 20260808000002_rls.sql 的 revoke-all：
-- 這裡新增的表**刻意不寫任何 grant**，預設就是 service-role-only。
-- 新增的函式一律先 `revoke all from public`（Postgres 對函式的預設是 grant
-- EXECUTE 給 PUBLIC，20260810000001 的 alter default privileges 只涵蓋
-- anon/authenticated，涵蓋不到 PUBLIC）。
-- =============================================================================


-- =============================================================================
-- 1. products.access_days —— 訂閱制的觀看期限
-- =============================================================================
--
-- 沒有這一欄的話，type = 'subscription' 的商品只有兩種下場：
-- 跳過不發 entitlement（客人買了年度計畫但「我的學習」是空的），
-- 或用 expires_at = null 發（把年度商品永久送出去）。兩個都不對。

alter table happyhands.products
  add column if not exists access_days int;

alter table happyhands.products
  drop constraint if exists products_access_days_positive;
alter table happyhands.products
  add constraint products_access_days_positive
  check (access_days is null or access_days > 0);

comment on column happyhands.products.access_days is
  '觀看天數。null = 永久回放（線上課的預設）。訂閱制填 365。'
  '開通時換算成 entitlements.expires_at。';


-- =============================================================================
-- 2. course_lessons.youtube_id —— 影片改放 YouTube（非公開）
-- =============================================================================
--
-- ⚠️ 為什麼不沿用既有的 video_path：
--    video_path 的語意是「Supabase Storage 私有 bucket 內的物件路徑」，
--    外洩只是一個沒用的字串（沒有簽名 URL 播不了）。
--    YouTube ID 外洩就是整支影片 —— 任何人 yt-dlp 一行就下載得到。
--    同一個欄位語意，風險等級完全不同，所以分開存、分開 grant。

alter table happyhands.course_lessons
  add column if not exists youtube_id text;

alter table happyhands.course_lessons
  drop constraint if exists course_lessons_youtube_id_format;
alter table happyhands.course_lessons
  add constraint course_lessons_youtube_id_format
  check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$');

comment on column happyhands.course_lessons.youtube_id is
  'YouTube 影片 ID（11 碼，非公開 unlisted）。'
  '⚠️ 這一欄沒有 grant 給 anon/authenticated，只有 service role 讀得到。'
  '播放一律由 POST /api/lessons/[id]/video 驗證 entitlements 後才回傳。';

comment on column happyhands.course_lessons.video_path is
  '⛔ 已停用。影片改放 YouTube（見 youtube_id），不再使用 Supabase Storage。'
  '保留欄位是為了不破壞 lesson-plan.ts 既有的兩階段搬移邏輯。';

-- --- table 層 grant 換成欄位級 -----------------------------------------------
--
-- 20260808000002_rls.sql:74-79 的註解說「因為 lib/data.ts 用
-- products.select("*, course_lessons(*)") 所以只能 table 層 grant」——
-- 那段註解**已經過期**。lib/data.ts:45,69 現在都是明列欄位：
--   course_lessons(title, duration_sec, free_preview, sort_order)
-- 其餘所有 course_lessons 查詢（admin/products/*）都走 service role。
-- 已逐一核對過，改成欄位級 grant 不會打到任何 anon 路徑。
--
-- 🔴 給後人：這張表現在是**欄位級 grant**。任何新的 anon/authenticated 查詢
--    只要寫成 course_lessons(*) 或用到不在下面白名單裡的欄位，就會整個查詢
--    permission denied（42501）——而且 lib/data.ts 的 catch 會回空陣列，
--    前台看起來像「課程全部下架」而不像錯誤。改這裡之前先讀這段。

revoke select on happyhands.course_lessons from anon, authenticated;

grant select (
  id, product_id, title, duration_sec, free_preview, sort_order,
  created_at, updated_at
) on happyhands.course_lessons to anon, authenticated;


-- =============================================================================
-- 3. 訂單歸戶用的索引
-- =============================================================================
--
-- backfill / claim 兩支都會用 lower(contact_email) 找未歸戶的訂單。
-- 沒有這個 partial index 的話兩支都是全表掃描。

create index if not exists idx_orders_unclaimed_email
  on happyhands.orders (lower(contact_email))
  where user_id is null and contact_email is not null;


-- =============================================================================
-- 4. find_auth_user_id() —— 「這個 Email 有沒有帳號」
-- =============================================================================
--
-- 為什麼需要這支：supabase-js 的 admin API 沒有 getUserByEmail()，
-- 而 app/admin/staff/queries.ts 的 loadUserEmailIndex() 是 O(全站帳號數) ——
-- 不能放在結帳熱路徑上。
--
-- 為什麼不會造成帳號枚舉：
--   1. PostgREST 只開放 public schema，連 service role 都不能直接
--      select auth.users。這支是唯一通道，這就是它存在的理由。
--   2. 只 grant 給 service_role。service role key 只在 Vercel 環境變數裡，
--      不進 client bundle。anon/authenticated 的 JWT 呼叫會拿到 permission denied。
--   3. 唯一呼叫端 /api/orders 不把結果回傳給前端（回應格式維持不變）。

create or replace function happyhands.find_auth_user_id(p_email text)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
    and u.deleted_at is null
  order by u.created_at
  limit 1
$$;

revoke all on function happyhands.find_auth_user_id(text) from public, anon, authenticated;
grant execute on function happyhands.find_auth_user_id(text) to service_role;

comment on function happyhands.find_auth_user_id(text) is
  '用 Email 反查 auth.users.id。service_role only —— 開給任何其他角色就是帳號枚舉。';


-- =============================================================================
-- 5. grant_entitlements_for_order() —— 付款後開通線上課程
-- =============================================================================
--
-- 呼叫點：app/admin/orders/actions.ts 的 transitionOrder()，在條件式 update
-- 拿到那一列之後（那是冪等的唯一勝出點）、writeAudit 之前，且排在 syncSeats()
-- 前面 —— 名額同步失敗只是「數字要人工對」，課程沒開通是「客人付了錢看不到課」。
--
-- 三道拒絕刻意回**結構化理由**而不是丟例外：呼叫端要能分辨並顯示不同的中文，
-- 而且「訂單已經標記收款了，但課沒開通」這件事一定要浮到畫面上，不能靜默。

create or replace function happyhands.grant_entitlements_for_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   happyhands.orders;
  v_granted int := 0;
  v_kept    int := 0;
  v_titles  text[];
begin
  select * into v_order from happyhands.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'granted', 0, 'kept', 0);
  end if;

  if v_order.status <> 'paid' then
    return jsonb_build_object('ok', false, 'reason', 'not_paid', 'granted', 0, 'kept', 0);
  end if;

  -- 訪客訂單（下單當下 Admin API 逾時、或這是改版前的歷史訂單）
  if v_order.user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_user', 'granted', 0, 'kept', 0);
  end if;

  -- init.sql 的欄位 comment 明寫「true 代表需人工複核後才能開通 entitlements」。
  -- 語意是「至少一個品項的單價是前端送上來的」—— 金額可能是 0。
  if v_order.price_unverified then
    return jsonb_build_object('ok', false, 'reason', 'price_unverified', 'granted', 0, 'kept', 0);
  end if;

  with wanted as (
    select distinct
      oi.product_id,
      p.title,
      case
        when p.access_days is null then null
        else now() + make_interval(days => p.access_days)
      end as expires_at
    from happyhands.order_items oi
    join happyhands.products p on p.id = oi.product_id
    where oi.order_id = p_order_id
      -- workshop 不發：報名名單本來就從 order_items join orders(status='paid')
      -- 即時算（見 worker 的 workshop-reminders.ts），而且 workshop 沒有
      -- course_lessons，發了也沒東西可看。
      and p.type in ('course', 'subscription')
  ),
  ins as (
    insert into happyhands.entitlements (user_id, product_id, order_id, granted_at, expires_at)
    select v_order.user_id, w.product_id, p_order_id, now(), w.expires_at
    from wanted w
    on conflict (user_id, product_id) do update set
      -- 權限只放寬、不收緊：任一邊是 null（永久）就是 null，
      -- 兩邊都有日期就取較晚的。重跑這支永遠不會讓客人少看到東西。
      expires_at = case
        when happyhands.entitlements.expires_at is null or excluded.expires_at is null then null
        else greatest(happyhands.entitlements.expires_at, excluded.expires_at)
      end,
      -- 同一門課可能來自兩筆訂單。order_id 只是資訊（我們不自動撤銷權限，
      -- 見 revoke_entitlement 的註解），取最早已知來源最不意外。
      order_id   = coalesce(happyhands.entitlements.order_id, excluded.order_id),
      updated_at = now()
    -- xmax = 0 是 PostgreSQL 判斷「這一列是 INSERT 進來的還是 ON CONFLICT
    -- 更新的」的標準寫法，不是筆誤。用它分辨「新開通」與「本來就有」。
    returning (xmax = 0) as inserted
  )
  select
    count(*) filter (where inserted)::int,
    count(*) filter (where not inserted)::int
  into v_granted, v_kept
  from ins;

  select array_agg(w.title order by w.title) into v_titles from wanted w;

  return jsonb_build_object(
    'ok', true,
    'granted', coalesce(v_granted, 0),
    'kept', coalesce(v_kept, 0),
    'products', coalesce(to_jsonb(v_titles), '[]'::jsonb)
  );
end;
$$;

revoke all on function happyhands.grant_entitlements_for_order(uuid) from public, anon, authenticated;
grant execute on function happyhands.grant_entitlements_for_order(uuid) to service_role;

comment on function happyhands.grant_entitlements_for_order(uuid) is
  '把一筆已付款訂單的線上課程開通給訂單的 user_id。冪等（重跑 granted=0、kept=N）。'
  '回 {ok, reason?, granted, kept, products[]}。reason 為 not_found/not_paid/no_user/price_unverified。';


-- =============================================================================
-- 5.5 count_unfulfilled_paid_orders() —— 「已收款但沒開通」的筆數
-- =============================================================================
--
-- 這個數字要放在 /admin 總覽上，因為那是**唯一每天會被看到的地方**。
-- 「客人付了錢但看不到課」如果只寫在 log 裡，就要等客人打 LINE 來問才會發現。
--
-- 判定：已付款 + 有線上課或訂閱制的品項 + 這筆訂單沒有產生過任何 entitlement。
-- 三個成因（user_id 是 null、price_unverified、RPC 當時失敗）都會落在這裡。

create or replace function happyhands.count_unfulfilled_paid_orders()
returns int
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from happyhands.orders o
  where o.status = 'paid'
    and exists (
      select 1
      from happyhands.order_items oi
      join happyhands.products p on p.id = oi.product_id
      where oi.order_id = o.id
        and p.type in ('course', 'subscription')
    )
    and not exists (
      select 1 from happyhands.entitlements e where e.order_id = o.id
    )
$$;

revoke all on function happyhands.count_unfulfilled_paid_orders() from public, anon, authenticated;
grant execute on function happyhands.count_unfulfilled_paid_orders() to service_role;

comment on function happyhands.count_unfulfilled_paid_orders() is
  '已收款、含線上課、卻沒有任何開通紀錄的訂單筆數。給 /admin 總覽的紅色數字用。';


-- =============================================================================
-- 6. revoke_entitlement() —— 人工撤銷單一門課的觀看權限
-- =============================================================================
--
-- ⚠️ 退款**不會**自動撤銷 entitlement，這是刻意的：
--    entitlements 的 PK 是 (user_id, product_id)，權限是跨訂單共用的。
--    客人重複下單、退掉其中一筆，自動撤銷會把**另一筆合法訂單**帶來的權限
--    一起刪掉。這是資料模型層面就決定的，不是靠寫得小心可以避開的。
--    加上退款理由不只一種（買錯、重複、工作坊取消、不滿意），只有最後一種
--    需要收回課程；而對 60–75 歲學員靜默關掉課程是客服災難。
--    所以：退款後由客服逐課按按鈕，每一次都寫 audit_log。

create or replace function happyhands.revoke_entitlement(p_user_id uuid, p_product_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  delete from happyhands.entitlements
  where user_id = p_user_id and product_id = p_product_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function happyhands.revoke_entitlement(uuid, uuid) from public, anon, authenticated;
grant execute on function happyhands.revoke_entitlement(uuid, uuid) to service_role;

comment on function happyhands.revoke_entitlement(uuid, uuid) is
  '撤銷一門課的觀看權限。只由客服人工觸發，退款不會自動呼叫（理由見函式內註解）。';


-- =============================================================================
-- 7. claim_guest_orders() —— 登入當下認領自己的訪客訂單
-- =============================================================================
--
-- 這一支是「用 LINE/Google 登入後看得到之前用同一個信箱下的單」真的成立的
-- 那一段。呼叫點：/auth/callback、/auth/confirm、/account layout。
--
-- 🔴🔴 `email_confirmed_at is not null` 這一行絕對不能拿掉。
--      少了它，任何人註冊一個未驗證的 victim@example.com 就能認領受害者的
--      訂單，看到姓名、電話、地址。這是整份會員中心計畫裡最容易寫錯、
--      後果最嚴重的一行。
--
-- 同理，email 一定要從 auth.users 讀，不可以信 JWT 裡的 claim。

create or replace function happyhands.claim_guest_orders()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_n     int;
begin
  if v_uid is null then
    return 0;
  end if;

  select lower(trim(u.email)) into v_email
  from auth.users u
  where u.id = v_uid
    and u.email_confirmed_at is not null   -- 🔴 見上方警告
    and u.deleted_at is null;

  if v_email is null or v_email = '' then
    return 0;
  end if;

  update happyhands.orders
  set user_id = v_uid, updated_at = now()
  where user_id is null
    and contact_email is not null
    and lower(trim(contact_email)) = v_email;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function happyhands.claim_guest_orders() from public, anon;
grant execute on function happyhands.claim_guest_orders() to authenticated, service_role;

comment on function happyhands.claim_guest_orders() is
  '把「contact_email 等於自己已驗證信箱」的未歸戶訂單認領過來，回認領筆數。'
  '登入後呼叫。只認 email_confirmed_at 有值的帳號，否則會變成越權讀取他人訂單。';


-- =============================================================================
-- 8. backfill_order_user_ids() —— 批次回填（一次性 + worker 每小時）
-- =============================================================================
--
-- 處理三種情形：改版前就存在的歷史訂單、下單當下 Admin API 逾時、
-- 以及「客人一週後才自己註冊」。同樣只認已驗證的帳號。

create or replace function happyhands.backfill_order_user_ids(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  with candidates as (
    select o.id, u.id as user_id
    from happyhands.orders o
    join auth.users u
      on lower(u.email) = lower(trim(o.contact_email))
    where o.user_id is null
      and o.contact_email is not null
      and u.email_confirmed_at is not null   -- 🔴 同 claim_guest_orders
      and u.deleted_at is null
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  )
  update happyhands.orders o
  set user_id = c.user_id, updated_at = now()
  from candidates c
  where o.id = c.id;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function happyhands.backfill_order_user_ids(int) from public, anon, authenticated;
grant execute on function happyhands.backfill_order_user_ids(int) to service_role;

comment on function happyhands.backfill_order_user_ids(int) is
  '批次把未歸戶訂單依 contact_email 綁到已驗證的帳號，回回填筆數。service_role only。';


-- =============================================================================
-- 9. email_outbox —— 交易信的收件匣模式
-- =============================================================================
--
-- 為什麼不直接在 route handler 裡呼叫 Resend：
-- Next.js 的 after() 沒有重試也沒有紀錄。Resend 掛 30 秒就會有一批人永遠
-- 收不到「設定密碼」信，而且任何地方都查不到。對「付了錢拿不到課」這件事
-- 這不可接受。
--
-- 流程：insert ... on conflict do nothing（冪等）→ after() 立刻試寄一次
--       → 失敗則 backoff → worker 每 2 分鐘掃 pending 重試
--
-- ⚠️ 刻意不寫任何 grant —— revoke-all 讓它預設就是 service-role-only。
--    收件人 Email 與信件內文都是個資，authenticated 不該讀得到別人的。

create table if not exists happyhands.email_outbox (
  id uuid primary key default gen_random_uuid(),

  -- 冪等鍵。例：'order_created:<order_id>'、'account_setup:<user_id>'、
  -- 'order_paid:<order_id>'、'workshop_reminder:<session_id>:<stage>'
  dedupe_key text not null unique,

  to_email   text not null,
  subject    text not null,
  body_text  text not null,
  body_html  text not null,

  status text not null default 'pending'
    constraint email_outbox_status_valid
    check (status in ('pending', 'sent', 'failed', 'skipped')),

  attempts    int not null default 0 constraint email_outbox_attempts_nonneg check (attempts >= 0),
  last_error  text,
  provider_id text,

  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table happyhands.email_outbox enable row level security;

create index if not exists idx_email_outbox_due
  on happyhands.email_outbox (next_attempt_at)
  where status = 'pending';

create index if not exists idx_email_outbox_to_created
  on happyhands.email_outbox (to_email, created_at desc);

drop trigger if exists trg_email_outbox_updated_at on happyhands.email_outbox;
create trigger trg_email_outbox_updated_at
  before update on happyhands.email_outbox
  for each row execute function happyhands.set_updated_at();

comment on table happyhands.email_outbox is
  '交易信的 outbox。dedupe_key 的 unique 就是冪等保證（連按兩下不會寄兩封）。'
  '沒有 grant = service-role-only。';
comment on column happyhands.email_outbox.dedupe_key is
  '冪等鍵，格式 <用途>:<實體 id>。同一把鑰匙永遠只會有一列，也就只會寄一次。';
comment on column happyhands.email_outbox.provider_id is
  'Resend 回傳的訊息 id。查「這封信到底寄出去了沒」時貼給 Resend 客服用。';


-- =============================================================================
-- 10. handle_new_user() 補 name fallback
-- =============================================================================
--
-- 現有版本只讀 raw_user_meta_data ->> 'full_name'。各種註冊來源給的欄位不同：
--   Email 註冊        什麼都沒有            → null（合理）
--   訪客結帳自動建帳號  full_name（我們自己塞的）→ ✅
--   Google           full_name 和 name      → ✅
--   LINE (custom OIDC) 只有 name           → ❌ 現在會讀到 null
--
-- 只多一個 coalesce，其餘邏輯（staff_invites 一次性消費）完全不動。

create or replace function happyhands.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = happyhands
as $$
declare
  v_email  text;
  v_invite happyhands.staff_invites%rowtype;
begin
  v_email := lower(trim(new.email));

  -- on conflict do nothing：使用者也可能自己先 insert 過（profiles_insert_own）
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

  if v_email is null or v_email = '' then
    return new;
  end if;

  -- 一次性消費：select 之後就刪掉，同一封邀請不會被第二個人用掉
  delete from happyhands.staff_invites
  where email = v_email
  returning * into v_invite;

  if found then
    update happyhands.profiles
    set role = v_invite.role
    where id = new.id;
  end if;

  return new;
end;
$$;
-- ===== 20260810000007_member_visibility.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 學員對「自己買過的東西」的可見性
-- =============================================================================
--
-- 🔴 這支修的是一個會靜默吃掉客人課程的問題。
--
-- 既有的三條 policy 都綁在 products.is_published = true：
--   products_select_published
--   course_lessons_select_published_product
--   workshop_sessions_select_published_product
--
-- 對公開目錄來說完全正確——下架的課本來就不該出現在 /courses。
-- 但會員中心用的是同一組 policy，於是：
--
--   客人買了《仁神術入門》→ 公司改版把它下架 →
--   客人的「我的學習」少一門課、訂單明細顯示「找不到課程」
--
-- 而且完全不會報錯，客人只會覺得「我買的課不見了」。
-- 這種下架在課程改版時很常見，不是罕見情境。
--
-- 修法：加上 OR 條件的 policy（policy 之間是 OR，所以只會放寬不會收緊）——
-- 「我有這門課的觀看權限」或「我買過它」就看得到，不管上下架。
--
-- 用 security definer 函式而不是直接把 exists 寫進 policy：
-- policy 的 USING 運算式裡引用其他表時，那些表的 RLS 也會套用，
-- 於是變成 products policy → orders policy → order_items policy 三層巢狀。
-- 不會遞迴，但很難推理、也很難查效能。包成函式讓它只做一件事。
-- =============================================================================


-- --- 我擁有這個商品嗎 --------------------------------------------------------
--
-- 「擁有」有兩種：已開通觀看權限（entitlements），或買過（order_items）。
-- 後者刻意不限定 status = 'paid'：待付款的訂單也要看得到自己買了什麼，
-- 否則訂單列表會出現一筆沒有品名的訂單。
--
-- ⚠️ 這支沒有 user 參數，一律用 auth.uid()——所以它只能回答
--    「**我**擁有嗎」，不能拿來窺探別人擁有什麼。這是安全設計的一部分，
--    要加參數之前先想清楚。

create or replace function happyhands.owns_product(p_product_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    exists (
      select 1
      from happyhands.entitlements e
      where e.product_id = p_product_id
        and e.user_id = (select auth.uid())
    )
    or exists (
      select 1
      from happyhands.order_items oi
      join happyhands.orders o on o.id = oi.order_id
      where oi.product_id = p_product_id
        and o.user_id = (select auth.uid())
    )
$$;

revoke all on function happyhands.owns_product(uuid) from public, anon;
grant execute on function happyhands.owns_product(uuid) to authenticated, service_role;

comment on function happyhands.owns_product(uuid) is
  '呼叫者是否擁有這個商品（有 entitlement 或買過）。'
  '刻意沒有 user 參數：只能問「我」，不能問別人。';


-- --- 我報名了這一場嗎 --------------------------------------------------------

create or replace function happyhands.registered_for_session(p_session_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from happyhands.order_items oi
    join happyhands.orders o on o.id = oi.order_id
    where oi.session_id = p_session_id
      and o.user_id = (select auth.uid())
  )
$$;

revoke all on function happyhands.registered_for_session(uuid) from public, anon;
grant execute on function happyhands.registered_for_session(uuid) to authenticated, service_role;

comment on function happyhands.registered_for_session(uuid) is
  '呼叫者是否報名過這一場工作坊。同 owns_product，只能問「我」。';


-- --- 三條放寬用的 policy -----------------------------------------------------
--
-- policy 之間是 OR。既有的 *_select_published 一條都不動，
-- 這裡只是多開一扇門給「已經付過錢的人」。

drop policy if exists "products_select_owned" on happyhands.products;
create policy "products_select_owned"
  on happyhands.products
  for select
  to authenticated
  using (happyhands.owns_product(id));

drop policy if exists "course_lessons_select_owned_product" on happyhands.course_lessons;
create policy "course_lessons_select_owned_product"
  on happyhands.course_lessons
  for select
  to authenticated
  using (happyhands.owns_product(product_id));

drop policy if exists "workshop_sessions_select_registered" on happyhands.workshop_sessions;
create policy "workshop_sessions_select_registered"
  on happyhands.workshop_sessions
  for select
  to authenticated
  using (
    happyhands.registered_for_session(id)
    or happyhands.owns_product(product_id)
  );
-- ===== 20260810000008_fix_grant_entitlements.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 修正 grant_entitlements_for_order()：CTE 跨語句不存在
-- =============================================================================
--
-- 20260810000006 的版本長這樣：
--
--   with wanted as (...), ins as (insert ... returning ...)
--   select count(...) into v_granted, v_kept from ins;
--
--   select array_agg(w.title) into v_titles from wanted w;   -- 🔴 這裡就爆了
--
-- CTE 的生存範圍是**單一 SQL 語句**。在 PL/pgSQL 裡上面是兩個獨立語句，
-- 所以第二句跑的時候 `wanted` 早就不存在了，直接丟
-- `42P01 relation "wanted" does not exist`。
--
-- 後果不是「少了商品名稱」而是整支函式失敗 →
-- transitionOrder() 會收到 error → 客服看到「開通線上課程時發生錯誤」→
-- 訂單標成已收款但課沒開通。實測抓到的，不是理論問題。
--
-- 修法：把三個值放進同一個語句一次取出，ins 與 wanted 在那個語句裡都還活著。
-- 其餘邏輯（三道拒絕、on conflict 只放寬不收緊、xmax = 0 判斷新舊）完全不動。
-- =============================================================================

create or replace function happyhands.grant_entitlements_for_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   happyhands.orders;
  v_granted int := 0;
  v_kept    int := 0;
  v_titles  text[];
begin
  select * into v_order from happyhands.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'granted', 0, 'kept', 0);
  end if;

  if v_order.status <> 'paid' then
    return jsonb_build_object('ok', false, 'reason', 'not_paid', 'granted', 0, 'kept', 0);
  end if;

  -- 訪客訂單（下單當下 Admin API 逾時、或這是改版前的歷史訂單）
  if v_order.user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_user', 'granted', 0, 'kept', 0);
  end if;

  -- init.sql 的欄位 comment 明寫「true 代表需人工複核後才能開通 entitlements」。
  -- 語意是「至少一個品項的單價是前端送上來的」—— 金額可能是 0。
  if v_order.price_unverified then
    return jsonb_build_object('ok', false, 'reason', 'price_unverified', 'granted', 0, 'kept', 0);
  end if;

  -- 🔴 三個值必須在同一個語句裡取出：CTE 活不過語句邊界。
  with wanted as (
    select distinct
      oi.product_id,
      p.title,
      case
        when p.access_days is null then null
        else now() + make_interval(days => p.access_days)
      end as expires_at
    from happyhands.order_items oi
    join happyhands.products p on p.id = oi.product_id
    where oi.order_id = p_order_id
      -- workshop 不發：報名名單本來就從 order_items join orders(status='paid')
      -- 即時算，而且 workshop 沒有 course_lessons，發了也沒東西可看。
      and p.type in ('course', 'subscription')
  ),
  ins as (
    insert into happyhands.entitlements (user_id, product_id, order_id, granted_at, expires_at)
    select v_order.user_id, w.product_id, p_order_id, now(), w.expires_at
    from wanted w
    on conflict (user_id, product_id) do update set
      -- 權限只放寬、不收緊：任一邊是 null（永久）就是 null，
      -- 兩邊都有日期就取較晚的。重跑永遠不會讓客人少看到東西。
      expires_at = case
        when happyhands.entitlements.expires_at is null or excluded.expires_at is null then null
        else greatest(happyhands.entitlements.expires_at, excluded.expires_at)
      end,
      -- 同一門課可能來自兩筆訂單。order_id 只是資訊（我們不自動撤銷權限），
      -- 取最早已知來源最不意外。
      order_id   = coalesce(happyhands.entitlements.order_id, excluded.order_id),
      updated_at = now()
    -- xmax = 0 是 PostgreSQL 判斷「這一列是 INSERT 進來的還是 ON CONFLICT
    -- 更新的」的標準寫法，不是筆誤。用它分辨「新開通」與「本來就有」。
    returning (xmax = 0) as inserted, product_id
  )
  select
    count(*) filter (where i.inserted)::int,
    count(*) filter (where not i.inserted)::int,
    array_agg(w.title order by w.title)
  into v_granted, v_kept, v_titles
  from ins i
  join wanted w on w.product_id = i.product_id;

  return jsonb_build_object(
    'ok', true,
    'granted', coalesce(v_granted, 0),
    'kept', coalesce(v_kept, 0),
    'products', coalesce(to_jsonb(v_titles), '[]'::jsonb)
  );
end;
$$;

revoke all on function happyhands.grant_entitlements_for_order(uuid) from public, anon, authenticated;
grant execute on function happyhands.grant_entitlements_for_order(uuid) to service_role;

comment on function happyhands.grant_entitlements_for_order(uuid) is
  '把一筆已付款訂單的線上課程開通給訂單的 user_id。冪等（重跑 granted=0、kept=N）。'
  '回 {ok, reason?, granted, kept, products[]}。reason 為 not_found/not_paid/no_user/price_unverified。';
-- ===== 20260817000001_payment_blackcat.sql =====
set search_path = happyhands, public, extensions;
-- 黑貓 PAY（統一客樂得多元支付平台）線上刷卡串接
--
-- 只做「線上刷卡」（COCS），收單行統一金流 PAYUNi。代收代付（ibon／ATM）
-- 這次不做 —— 客戶決定，且那條路要另外處理繳款到期日與繳款碼顯示。
--
-- ⚠️ 欄位放哪裡是有意義的安全決定：
--    `orders` 對 authenticated 是 **table 層 grant**（rls.sql:144 `grant select, insert`），
--    所以任何加到 orders 的欄位，學員在 /account 都看得到自己那筆。
--    因此 orders 上只放「本人看到也無妨」的欄位（交易編號、卡號末四碼、付款網址）。
--    APN 的完整原始封包另存 payment_events —— 那張表**不寫任何 grant**，
--    等於 service-role only（比照 email_outbox、staff_invites 的做法）。

-- ---------------------------------------------------------------------------
-- orders：付款狀態欄位
-- ---------------------------------------------------------------------------

alter table happyhands.orders
  add column if not exists payment_provider     text,
  add column if not exists payment_trade_no     text,
  add column if not exists payment_url          text,
  add column if not exists payment_status_code  text,
  add column if not exists payment_paid_amount  int,
  add column if not exists payment_card_no      text,
  add column if not exists payment_auth_code    text,
  add column if not exists payment_notified_at  timestamptz;

comment on column happyhands.orders.payment_provider is
  '金流商代號，目前只有 blackcat（統一客樂得黑貓 PAY）。null = 沒走線上金流（客服手動收款）。';
comment on column happyhands.orders.payment_trade_no is
  'APN 的 trans_id：黑貓 PAY 給每筆刷卡訂單的唯一交易識別碼，客服對帳用。';
comment on column happyhands.orders.payment_url is
  '黑貓 PAY 回傳的線上刷卡網址。客人關掉分頁後可以再點一次付款，所以要存下來。';
comment on column happyhands.orders.payment_status_code is
  'APN 的 status 單一字母：B=授權完成 O=請款作業中 E=請款完成 F=授權失敗 D=訂單逾期 '
  'P=請款失敗 M=取消交易完成 N=取消交易失敗 Q=取消授權完成 R=取消授權失敗。';
comment on column happyhands.orders.payment_paid_amount is
  '實際授權金額（APN payment_detail.pay_amount）。**這才是判斷收到多少錢的依據**，'
  '不可以用 APN 的 amount —— 那是繳款單金額，而且 checksum 算的是它，'
  '所以 checksum 通過不代表金額正確（規格 P35 注意事項 2 紅字明寫要用實收金額比對）。';
comment on column happyhands.orders.payment_card_no is '信用卡號前六後四碼，客服對帳用。';

alter table happyhands.orders
  drop constraint if exists orders_payment_provider_valid;
alter table happyhands.orders
  add constraint orders_payment_provider_valid
    check (payment_provider is null or payment_provider in ('blackcat'));

-- 收到 APN 時要用 trans_id 反查訂單
create index if not exists idx_orders_payment_trade_no
  on happyhands.orders (payment_trade_no)
  where payment_trade_no is not null;

-- ---------------------------------------------------------------------------
-- payment_events：APN 通知的完整紀錄（service-role only）
-- ---------------------------------------------------------------------------

create table if not exists happyhands.payment_events (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references happyhands.orders(id) on delete set null,
  provider     text        not null default 'blackcat',
  trans_id     text        not null,
  order_no     text,
  status_code  text        not null,
  amount       int,
  pay_amount   int,
  nonce        text,
  raw          jsonb       not null,
  -- 處理結果，方便事後查「為什麼這筆沒開通」
  outcome      text        not null,
  note         text,
  created_at   timestamptz not null default now()
);

-- 冪等的執行點。規格 P87：APN 每 15 分鐘重送、同一個狀態碼最多送 3 次。
-- 不能把 nonce 放進 unique —— 每次重送的 nonce 都不一樣，那樣就擋不住重複。
-- 用 (provider, trans_id, status_code) 才是「同一筆交易的同一個狀態只處理一次」。
create unique index if not exists payment_events_dedupe
  on happyhands.payment_events (provider, trans_id, status_code);

create index if not exists idx_payment_events_order
  on happyhands.payment_events (order_id, created_at desc);

comment on table happyhands.payment_events is
  '黑貓 PAY APN 主動通知的完整紀錄。**刻意不寫任何 grant = service-role only**，'
  '因為 raw 裡有卡號與授權碼。學員要看的付款狀態放在 orders 的 payment_* 欄位。';
comment on column happyhands.payment_events.outcome is
  'applied=有更新訂單／duplicate=同狀態重送已忽略／amount_mismatch=實收與應收不符（沒開通）／'
  'order_not_found=找不到訂單／ignored=狀態碼不需處理。';

-- 這張表刻意不 grant 給 anon/authenticated。
-- rls.sql 的基底已經 revoke all，這裡不補 grant 就是 service-role only。
alter table happyhands.payment_events enable row level security;

-- ---------------------------------------------------------------------------
-- 後台總覽：付款異常的筆數（給 /admin 顯示紅字用）
-- ---------------------------------------------------------------------------

create or replace function happyhands.count_payment_alerts()
returns int
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from happyhands.payment_events
  where outcome in ('amount_mismatch', 'order_not_found')
    and created_at > now() - interval '30 days'
$$;

revoke all on function happyhands.count_payment_alerts() from public, anon, authenticated;
grant execute on function happyhands.count_payment_alerts() to service_role;

comment on function happyhands.count_payment_alerts() is
  '近 30 天實收金額不符或找不到訂單的 APN 筆數。這兩種都代表有人付了錢卻沒拿到東西，'
  '必須有人看到 —— 顯示在 /admin 總覽。';
-- ===== 20260827000001_seat_hold_window.sql =====
set search_path = happyhands, public, extensions;
-- 未付款訂單的佔位時效
--
-- 問題：checkSessionCapacity（api/orders）把**所有** status='pending' 的
-- order_items 都算成佔位，但沒有任何機制讓它過期 ——
-- init.sql 設計的 seat_holds 表與 release_expired_seat_holds() 從來沒被
-- apps/web 寫入過（grep 零命中），所以那條回收路徑實際上是空的。
-- 結果是：客人下單不付款，那個位子就**永遠**被佔著。
--
-- 而且前台顯示走的是另一段算式（session-row.tsx: capacity - seats_taken），
-- 完全沒扣掉 pending，所以會出現「頁面說剩 4 位、結帳卻說滿了」。
--
-- 這支 migration 把「佔位」變成單一定義，前台顯示與下單檢查都改讀它。

-- 佔位有效時間。刷卡通常幾分鐘內完成；放寬到 30 分鐘容納「離開再回來付」。
-- 代價是有極小機率超賣（客人第 31 分鐘才付款成功，位子已被別人拿走）——
-- 工作坊超賣一兩個位子可以現場加椅子，但「名額被永久佔住」會讓真正想報名
-- 的人一直被擋在門外，那個更糟。
create or replace function happyhands.seat_hold_window()
returns interval
language sql
immutable
as $$ select interval '30 minutes' $$;

comment on function happyhands.seat_hold_window() is
  '未付款訂單佔住工作坊名額的有效時間。改這裡就同時改到前台顯示與下單檢查。';

-- 每個場次目前被「有效的未付款訂單」佔住幾個位子。
-- security definer：前台是 anon client，讀不到 orders/order_items。
-- 只回傳場次 id 與數量，沒有任何個資，所以可以開給 anon。
create or replace function happyhands.workshop_holds()
returns table (session_id uuid, held int)
language sql
security definer
stable
set search_path = ''
as $$
  select oi.session_id, sum(oi.qty)::int as held
  from happyhands.order_items oi
  join happyhands.orders o on o.id = oi.order_id
  where o.status = 'pending'
    and oi.session_id is not null
    and o.created_at > now() - happyhands.seat_hold_window()
  group by oi.session_id
$$;

revoke all on function happyhands.workshop_holds() from public;
grant execute on function happyhands.workshop_holds() to anon, authenticated, service_role;

comment on function happyhands.workshop_holds() is
  '各場次被有效未付款訂單佔住的名額數。前台顯示剩餘名額與 /api/orders 的容量檢查'
  '都要用這一支，否則兩邊算式會再度分岔。';
-- ===== 20260827000002_list_unfulfilled_orders.sql =====
set search_path = happyhands, public, extensions;
-- 列出「已收款但沒開通」的訂單，給每日 cron 補救用。
--
-- 為什麼需要這一支：cron 原本是抓 status='paid' 的訂單 limit 50 逐筆重跑
-- grant_entitlements_for_order。grant 本身是冪等的所以不會出錯，但抓到的
-- 永遠是同樣的前 50 筆（早就開通過的），訂單一旦累積超過 50 筆，真正漏開通
-- 的那筆就永遠輪不到 —— 補救機制本身會靜默失效。
--
-- 條件與 count_unfulfilled_paid_orders() 完全一致，只是回傳清單而不是數量。
-- 兩支要一起改，否則 /admin 顯示的數字會跟 cron 實際處理的對不起來。
create or replace function happyhands.list_unfulfilled_paid_orders(p_limit int default 50)
returns table (id uuid, order_no text)
language sql
security definer
stable
set search_path = ''
as $$
  select o.id, o.order_no
  from happyhands.orders o
  where o.status = 'paid'
    and o.price_unverified = false
    and o.user_id is not null
    and exists (
      select 1
      from happyhands.order_items oi
      join happyhands.products p on p.id = oi.product_id
      where oi.order_id = o.id
        and p.type in ('course', 'subscription')
    )
    and not exists (
      select 1 from happyhands.entitlements e where e.order_id = o.id
    )
  order by o.paid_at nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 500))
$$;

revoke all on function happyhands.list_unfulfilled_paid_orders(int) from public, anon, authenticated;
grant execute on function happyhands.list_unfulfilled_paid_orders(int) to service_role;

comment on function happyhands.list_unfulfilled_paid_orders(int) is
  '已收款、金額已核、已綁帳號，但還沒開通任何 entitlement 的訂單。'
  '條件與 count_unfulfilled_paid_orders() 一致，改一支要改兩支。';
-- ===== 20260827000003_workshop_content.sql =====
set search_path = happyhands, public, extensions;
-- 工作坊報名頁的可上架內容
--
-- 目標：客戶每次開新工作坊時，從後台填內容就有一個完整的報名頁，
-- 不用再另外做一個頁面。參考的是客戶現有的 jsjselfhelp.mygoodday.com.tw。
--
-- 分兩種存法，理由是編輯體驗不同：
--   ・純條列（適合對象、學習成果、課程大綱…）→ products 的 text[] 欄位，
--     後台沿用既有「一行一項 textarea」，最好填
--   ・有結構又會增減的（FAQ、步驟、費用表列、價格方案）→ product_blocks 子表，
--     因為 FAQ 答案動輒兩三百字，text[] 放不下；步驟與費用列是 key-value

-- ---------------------------------------------------------------------------
-- 1. products：固定內容欄位（留空前台就整塊不顯示）
-- ---------------------------------------------------------------------------

alter table happyhands.products
  add column if not exists hero_lead          text,
  add column if not exists suitable_for       text[] not null default '{}',
  add column if not exists not_suitable_for   text[] not null default '{}',
  add column if not exists outcomes           text[] not null default '{}',
  add column if not exists curriculum_online  text[] not null default '{}',
  add column if not exists curriculum_onsite  text[] not null default '{}',
  add column if not exists includes           text[] not null default '{}',
  add column if not exists notes              text[] not null default '{}',
  add column if not exists asks_intake        boolean not null default false;

comment on column happyhands.products.hero_lead is
  '標題下方的引言，可多段（前台用 whitespace-pre-line 保留換行）。'
  '⚠️ 既有的 description 是塞進單一 <p> 的純文字，後台打的換行會被 HTML 折疊掉。';
comment on column happyhands.products.suitable_for is '「這堂課適合誰」條列。';
comment on column happyhands.products.not_suitable_for is
  '「目前可能不適合」條列。與 suitable_for 併成兩欄對比區塊；兩邊都空就整塊不顯示。';
comment on column happyhands.products.outcomes is '「學完之後可以做到什麼」條列。';
comment on column happyhands.products.curriculum_online is '線上課程內容大綱。';
comment on column happyhands.products.curriculum_onsite is
  '實體課程內容大綱。與 curriculum_online 併成兩欄；只有一邊有內容就顯示一欄。';
comment on column happyhands.products.includes is '「一次報名，全部帶走」的配套清單，前台渲染成標籤雲。';
comment on column happyhands.products.notes is
  '「來之前先知道」注意事項。原本寫死在 workshops/[slug]/page.tsx 的 JSX 字串陣列裡。';
comment on column happyhands.products.asks_intake is
  '結帳時是否要多問報名問題（學習經驗、想改善什麼、從哪得知）並要求勾選健康聲明。';

-- ---------------------------------------------------------------------------
-- 2. workshop_sessions：梯次自己的名稱、摘要與價格
-- ---------------------------------------------------------------------------

alter table happyhands.workshop_sessions
  add column if not exists title    text,
  add column if not exists summary  text,
  add column if not exists format   text,
  add column if not exists price    int,
  add column if not exists notes    text;

alter table happyhands.workshop_sessions
  drop constraint if exists workshop_sessions_price_nonneg;
alter table happyhands.workshop_sessions
  add constraint workshop_sessions_price_nonneg
    check (price is null or price >= 0);

alter table happyhands.workshop_sessions
  drop constraint if exists workshop_sessions_format_valid;
alter table happyhands.workshop_sessions
  add constraint workshop_sessions_format_valid
    check (format is null or format in ('onsite', 'online', 'hybrid'));

comment on column happyhands.workshop_sessions.title is
  '梯次名稱，例如「2026 年 9 月假日班」。留空時前台用日期組一個。';
comment on column happyhands.workshop_sessions.summary is
  '梯次一句話摘要，例如「9/12（六）、9/13（日）／每天 7.5 小時，共 15 小時實體練習」。';
comment on column happyhands.workshop_sessions.format is '上課形式 onsite/online/hybrid。';
comment on column happyhands.workshop_sessions.price is
  '🔴 這一梯的價格。null = 用 products.price。'
  '同一門課的不同梯次價格可以差很多（客戶現有站從 1,200 到 12,800 都有）。'
  '⚠️ 伺服器端重算訂單金額時必須優先讀這一欄 —— 見 apps/web/app/api/orders/route.ts '
  '的 loadPriceBook()。漏掉就是收錯錢。';
comment on column happyhands.workshop_sessions.notes is
  '梯次補充說明，例如「直播連結於開課前發送」。';

-- ---------------------------------------------------------------------------
-- 3. product_blocks：有結構、會增減、需要排序的內容
-- ---------------------------------------------------------------------------

create table if not exists happyhands.product_blocks (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid        not null references happyhands.products(id) on delete cascade,
  kind        text        not null,
  sort_order  int         not null,
  title       text,
  body        text,
  meta        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint product_blocks_kind_valid
    check (kind in ('faq', 'step', 'info_row', 'pricing', 'feature')),
  constraint product_blocks_sort_nonneg check (sort_order >= 0),
  -- 每種 kind 各自排序。排序更新要用 PARK→FINAL 兩階段（見
  -- apps/web/app/admin/products/lesson-plan.ts）：逐筆改成目標值一定會撞這個約束。
  constraint product_blocks_kind_sort_key unique (product_id, kind, sort_order)
);

create index if not exists idx_product_blocks_product_kind
  on happyhands.product_blocks (product_id, kind, sort_order);

comment on table happyhands.product_blocks is
  '課程／工作坊頁面上「有結構又會增減」的內容區塊。kind 決定前台怎麼渲染。';
comment on column happyhands.product_blocks.kind is
  'faq: title=問題 body=答案／step: title=階段名 body=說明（前台自動編號）／'
  'info_row: title=欄位名 body=內容（費用資訊表的一列）／'
  'pricing: title=方案名 body=說明，meta.amount 金額、meta.note 附註／'
  'feature: title=標題 body=說明（陪伴機制那種三欄卡片）';
comment on column happyhands.product_blocks.meta is
  '各 kind 專屬的額外欄位。刻意用 jsonb 而不是再開一堆稀疏欄位。';

drop trigger if exists trg_product_blocks_updated_at on happyhands.product_blocks;
create trigger trg_product_blocks_updated_at
  before update on happyhands.product_blocks
  for each row execute function happyhands.set_updated_at();

-- RLS：比照 course_lessons —— 只看得到已發布商品的區塊
alter table happyhands.product_blocks enable row level security;

revoke all on happyhands.product_blocks from anon, authenticated;
grant select on happyhands.product_blocks to anon, authenticated;

drop policy if exists product_blocks_select_published on happyhands.product_blocks;
create policy product_blocks_select_published on happyhands.product_blocks
  for select
  to anon, authenticated
  using (
    exists (
      select 1 from happyhands.products p
      where p.id = product_blocks.product_id
        and p.is_published = true
    )
  );

-- 已購買者看得到未發布商品的內容（比照 20260810000007 的 owns_product 放寬）
drop policy if exists product_blocks_select_owned on happyhands.product_blocks;
create policy product_blocks_select_owned on happyhands.product_blocks
  for select
  to authenticated
  using (happyhands.owns_product(product_id));
-- ===== 20260827000004_intake_and_settings.sql =====
set search_path = happyhands, public, extensions;
-- 報名問題與站台共用內容

-- ---------------------------------------------------------------------------
-- 1. orders：結帳時多問的報名問題
-- ---------------------------------------------------------------------------
--
-- ⚠️ orders 對 authenticated 是 table 層 grant，所以這幾欄學員在 /account
--    看得到自己那筆 —— 那本來就是他自己填的，沒有隱私問題。

alter table happyhands.orders
  add column if not exists intake_experience text,
  add column if not exists intake_goal       text,
  add column if not exists intake_source     text,
  add column if not exists health_ack_at     timestamptz;

comment on column happyhands.orders.intake_experience is
  '報名問題：是否有相關學習經驗（none/heard/formal）。';
comment on column happyhands.orders.intake_goal is
  '報名問題：最希望理解或改善什麼。給老師備課用。';
comment on column happyhands.orders.intake_source is
  '報名問題：從哪裡得知這堂課。招生成效分析用。';
comment on column happyhands.orders.health_ack_at is
  '勾選健康聲明的時間。⚠️ 這是法律證據，不要只存 boolean —— 要留得下「什麼時候同意的」。';

-- ---------------------------------------------------------------------------
-- 2. site_settings：所有課共用的內容
-- ---------------------------------------------------------------------------
--
-- 講師介紹、健康聲明這類東西每門課都一樣，不該在每個商品重填一次。
-- 目前它們寫死在 apps/web/lib/content.ts 的 TEACHER 常數裡。

create table if not exists happyhands.site_settings (
  key         text        primary key,
  value       jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

comment on table happyhands.site_settings is
  '站台共用內容，key-value。目前用到的 key：'
  'teacher（講師介紹：name/title/paragraphs[]/credentials[]/links[]/photo_url）、'
  'health_notice（健康聲明全文）、payment_note（匯款與付款說明）。';

drop trigger if exists trg_site_settings_updated_at on happyhands.site_settings;
create trigger trg_site_settings_updated_at
  before update on happyhands.site_settings
  for each row execute function happyhands.set_updated_at();

alter table happyhands.site_settings enable row level security;

revoke all on happyhands.site_settings from anon, authenticated;
grant select on happyhands.site_settings to anon, authenticated;

-- 站台文案本來就是公開內容，全部開放讀取
drop policy if exists site_settings_select_all on happyhands.site_settings;
create policy site_settings_select_all on happyhands.site_settings
  for select
  to anon, authenticated
  using (true);
-- ===== 20260827000005_workshop_intake_default.sql =====
set search_path = happyhands, public, extensions;
-- 有實體場次的商品，結帳時要問報名問題並勾健康聲明。
--
-- asks_intake 在 20260827000003 加進來時預設 false，但前台原本的行為是
-- 「購物車裡有工作坊就問」。把後台旗標接上去之後，如果不補這一筆，
-- 已經在賣的場次會突然不再要求勾健康聲明 —— 而 orders.health_ack_at
-- 是法律證據，不能靜默消失。
--
-- 🔴 條件不能只寫 type = 'workshop'：pulse-reading（讀脈入門課）是
--    type = 'course' 卻有實體場次，會出現在 /workshops 上讓人報名。
--    判準是「有沒有場次」，不是商品型別。
--
-- 純線上課維持 false：買了就能看，老師不需要事先知道學員狀況。
update happyhands.products p
   set asks_intake = true
 where p.asks_intake is distinct from true
   and (
     p.type = 'workshop'
     or exists (
       select 1 from happyhands.workshop_sessions ws where ws.product_id = p.id
     )
   );
-- ===== 20260827000006_ai_helper.sql =====
set search_path = happyhands, public, extensions;
-- AI 小幫手：對話記錄、聯絡資訊萃取、用量上限。
--
-- 這張表存的是**未登入訪客**在官網右下角小幫手裡打的字，可能含姓名、
-- Email、電話、LINE ID，也可能含身體狀況（「我膝蓋開過刀可以學嗎」）。
-- 那是健康資訊。所以：
--   * 完全不給 anon 與 authenticated —— 連 grant 都不發，只有 service role 進得來。
--   * 讀取一律經過 /admin 的 requireCapability 守衛，不走 RLS 放行。
-- 這跟 orders 不同：orders 要讓學員在 /account 看自己的單，所以有 table 層 grant。

create table if not exists happyhands.ai_chat_logs (
  id uuid primary key default gen_random_uuid(),

  -- 一段對話一列。session_id 由前端產生（crypto.randomUUID）存在 sessionStorage，
  -- 關掉分頁就換一段新的。unique 讓每一輪回覆都能 upsert 回同一列。
  session_id text not null unique,

  -- 完整逐字稿 [{role:'user'|'model', text}]
  messages jsonb not null default '[]'::jsonb,
  message_count int not null default 0,
  first_question text,
  last_reply text,

  user_ip text,
  user_agent text,

  -- AI 從對話中萃取的聯絡資訊與需求（訪客自己講的才算，不推測）
  contact_name text,
  contact_phone text,
  contact_email text,
  contact_line text,
  summary text,
  intent text,

  -- 🔴 generated 而不是由程式維護：給樂那套是應用層自己寫 has_contact，
  --    只要有一條寫入路徑忘記更新，後台的「待跟進」清單就會漏人。
  --    交給資料庫算就不可能漂移。
  has_contact boolean generated always as (
    contact_name is not null
    or contact_phone is not null
    or contact_email is not null
    or contact_line is not null
  ) stored,

  -- 後台跟進狀態
  handled_at timestamptz,
  handled_by uuid references auth.users(id) on delete set null,
  handled_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table happyhands.ai_chat_logs is
  'AI 小幫手對話記錄。含訪客個資與可能的健康資訊，只有 service role 讀得到。';

-- 後台預設看「有留聯絡資訊、還沒處理」的，這個索引撐那一頁
create index if not exists ai_chat_logs_followup_idx
  on happyhands.ai_chat_logs (created_at desc)
  where has_contact and handled_at is null;

create index if not exists ai_chat_logs_created_idx
  on happyhands.ai_chat_logs (created_at desc);

alter table happyhands.ai_chat_logs enable row level security;
revoke all on happyhands.ai_chat_logs from anon, authenticated;
-- 刻意不建任何 policy：service role 繞過 RLS，其他人一律進不來。

/* ------------------------------------------------------------------ 用量上限 */

-- 沒有上限的話，一支腳本就能把 Gemini 的額度打光（帳單是客戶的），
-- 而且對話內容會被灌進上面那張表。每天重置，不必另外清理。
create table if not exists happyhands.ai_rate_limits (
  bucket text not null,
  day date not null default (now() at time zone 'utc')::date,
  hits int not null default 0,
  primary key (bucket, day)
);

alter table happyhands.ai_rate_limits enable row level security;
revoke all on happyhands.ai_rate_limits from anon, authenticated;

/**
 * 記一次用量並回報「還可不可以用」。
 *
 * 🔴 用 insert ... on conflict do update 的原子加總，不是先 select 再 update：
 *    同一個 IP 同時開兩個分頁狂送，read-then-write 會兩邊都讀到 39、
 *    兩邊都寫 40，上限直接被繞過。
 *
 * 回 true = 這次放行。
 */
create or replace function happyhands.ai_rate_check(p_bucket text, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hits int;
begin
  insert into happyhands.ai_rate_limits (bucket, day, hits)
  values (p_bucket, (now() at time zone 'utc')::date, 1)
  on conflict (bucket, day)
  do update set hits = happyhands.ai_rate_limits.hits + 1
  returning hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

revoke all on function happyhands.ai_rate_check(text, int) from public, anon, authenticated;
grant execute on function happyhands.ai_rate_check(text, int) to service_role;

/**
 * 後台「待跟進」數字。比照既有的 count_unfulfilled_paid_orders()。
 */
create or replace function happyhands.count_pending_inquiries()
returns int
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
    from happyhands.ai_chat_logs
   where has_contact and handled_at is null
$$;

revoke all on function happyhands.count_pending_inquiries() from public, anon, authenticated;
grant execute on function happyhands.count_pending_inquiries() to service_role;
-- ===== 20260828000001_lesson_content.sql =====
set search_path = happyhands, public, extensions;
-- =============================================================================
-- 快樂手 — 每一堂課的文字內容、講義與圖片
--
-- 老師想在單元裡放的東西有三種：一段文字說明、課程文件（PDF 講義），
-- 以及課內插圖。三種都是**賣出去的內容**，跟影片同一個付費牆。
-- =============================================================================

-- ── 1. 單元文字 ────────────────────────────────────────────────────────────
--
-- 純文字，換行原樣保留、空一行分段（渲染時 split(/\n{2,}/)）。
-- 不用 text[]：那組是給「一行一項」的清單用的，而且 shared.ts 的
-- linesToArray() 有每項 60 字的靜默截斷 —— 段落一定會被切掉。
alter table happyhands.course_lessons
  add column if not exists body text;

comment on column happyhands.course_lessons.body is
  '這一堂的文字說明。空一行分段。與 youtube_id 一樣屬於付費內容。';

-- ⚠️ 刻意不建立任何 storage.objects 的 policy（與 media bucket 同一個模型）：
--    沒有 policy → anon/authenticated 既讀不到也寫不進去。
--    讀取只能透過 server 端用 service role 產生的簽章網址，
--    寫入只能經 /api/admin/materials（驗員工身分）。
--
-- ⚠️⚠️ 不要「順手補齊 RLS」加 select policy —— 加了之後任何登入者都能
--       storage.list() 把整個 bucket 的檔名列出來，甚至直接下載。
--       這是刻意的留白，不是遺漏。

-- ── 3. 講義與圖片的索引表 ──────────────────────────────────────────────────

create table if not exists happyhands.lesson_materials (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null
    references happyhands.course_lessons(id) on delete cascade,

  -- file = 可下載的講義；image = 顯示在課程內容裡的插圖
  kind text not null,
  constraint lesson_materials_kind_valid check (kind in ('file', 'image')),

  /** bucket 內的相對路徑，例如 lessons/<lesson_id>/<uuid>.pdf */
  storage_path text not null unique,
  /** 上傳時的原始檔名。學員下載時看到的就是這個，不是 uuid。 */
  file_name text not null,
  mime_type text not null,
  size_bytes int not null,
  /** 圖片說明。file 不用。 */
  caption text,

  sort_order int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lesson_materials_sort_key unique (lesson_id, kind, sort_order)
);

comment on table happyhands.lesson_materials is
  '單元的講義與插圖。檔案本體在私有 bucket course-materials，讀取一律走簽章網址。';

create index if not exists lesson_materials_lesson_idx
  on happyhands.lesson_materials (lesson_id, kind, sort_order);

alter table happyhands.lesson_materials enable row level security;

-- 🔴 完全不發 grant 給 anon / authenticated。
--    這張表本身沒有機密，但「哪一堂有幾份講義、檔名叫什麼」就是課程大綱，
--    而且一旦給了 select，前端就能拿到 storage_path 去猜。
--    學員端一律經 /api/lessons/[id]/materials（驗過 entitlement 才回傳）。
revoke all on happyhands.lesson_materials from anon, authenticated;
-- ===== 20260831000001_invoice_amego.sql =====
set search_path = happyhands, public, extensions;
-- ---------------------------------------------------------------------------
-- 電子發票（Amego）
--
-- 台灣的公司賣東西給消費者是法定要開電子發票的，這個站到目前為止完全沒有做 ——
-- 沒有欄位、沒有表、沒有 API。這支把整條線補起來。
--
-- 🔴 這張表的設計核心只有一句話：**發票開出去撤不回來**。
--    財政部那邊多一張就是多一張，只能再開一張作廢單去沖銷，而客人的信箱裡已經
--    躺著兩份稅務憑證。所以不能沿用 email_outbox 那種「先送再記」的樂觀模式 ——
--    寄信重複只是尷尬，開票重複是稅務事故。
--
--    改成 claim-then-act：
--      1. claim_invoice_issue()  原子地宣告「這張由我開」（status → 'issuing'）
--      2. 呼叫 Amego             只有拿到 claim 的人可以做這一步
--      3. finish / fail          一定要走到其中一個
--
--    這個順序讓「已送出但還沒記錄」在資料庫裡**看得見**（status='issuing'）。
--    少了它，從 Amego 回應到 UPDATE 落地之間行程被殺，這一列還是 pending，
--    下一次重試就開出第二張真發票 —— 而且沒有任何痕跡看得出來。
--
-- 冪等有兩道獨立的保險，互為 fallback（缺一不可）：
--   主動  開票前先用 invoice_query 反查 Amego，查得到號碼就認回、不重開
--   被動  c0401 回 3040171（OrderId 重複）→ 回頭查一次再認回
--   兩道都成立的前提是 OrderId = orders.order_no（init.sql:246 是 unique），
--   也就是把 Amego 那邊的唯一性約束借來當我們的冪等鍵。
--
-- ## 套用順序：**先 DB，後程式碼**
--    本檔全部是加欄位／建表／建函式，向後相容：舊版程式碼（不認識這些東西）
--    套用後行為完全不變。反過來先部署程式碼，claim RPC 會回 PGRST202
--    （function not found），開票全數停擺。
-- ---------------------------------------------------------------------------

-- ── 1. orders：客人自己填的發票資料，以及開完之後給他看的號碼 ───────────────
--
-- 為什麼放在 orders 而不是另開一張表：orders 對 authenticated 是 **table 層
-- grant**（rls.sql:144 grant select, insert），所以放這裡學員在 /account 就
-- 看得到自己那筆。這幾個欄位本來就是「他自己填的」與「他的發票號碼」，
-- 本人看到完全沒問題 —— 比照 20260817000001_payment_blackcat.sql:6-11 的判準。
--
-- 開票的機器（重試次數、錯誤訊息、送出去的原始封包）另存 happyhands.invoices，
-- 那張表不寫任何 grant = service-role only。

alter table happyhands.orders
  add column if not exists invoice_carrier_type text,
  add column if not exists invoice_carrier_id   text,
  add column if not exists invoice_tax_id       text,
  add column if not exists invoice_title        text,
  add column if not exists invoice_number       text,
  add column if not exists invoice_random_code  text,
  add column if not exists invoice_issued_at    timestamptz;

alter table happyhands.orders drop constraint if exists orders_invoice_carrier_type_check;
alter table happyhands.orders add constraint orders_invoice_carrier_type_check
  check (
    invoice_carrier_type is null
    or invoice_carrier_type in ('cloud', 'phone', 'natural_person', 'love_code', 'b2b')
  );

-- 統編一律 8 碼數字。檢查碼的驗證在 TS 端做（lib/invoice/validate.ts），
-- 這裡只擋格式 —— DB 端算檢查碼會讓 constraint 難讀又難改。
alter table happyhands.orders drop constraint if exists orders_invoice_tax_id_check;
alter table happyhands.orders add constraint orders_invoice_tax_id_check
  check (invoice_tax_id is null or invoice_tax_id ~ '^[0-9]{8}$');

comment on column happyhands.orders.invoice_carrier_type is
  'cloud=雲端發票（預設）/ phone=手機條碼 / natural_person=自然人憑證 / love_code=捐贈 / b2b=公司統編。'
  ' 客人在結帳時選的。null 視同 cloud。';
comment on column happyhands.orders.invoice_carrier_id is
  '載具號碼或愛心碼。carrier_type=phone 時是 /XXXXXXX（斜線開頭共 8 碼），'
  ' natural_person 是 2 大寫英文+14 數字，love_code 是 3~7 碼數字。b2b 與 cloud 留空。';
comment on column happyhands.orders.invoice_tax_id is
  '買方統一編號，只有 carrier_type=b2b 才有值。有值就是三聯式，稅額要另外拆出來。';
comment on column happyhands.orders.invoice_title is '買方抬頭（公司名），只有 b2b 用得到。';
comment on column happyhands.orders.invoice_number is
  '⚠️ 這是 happyhands.invoices 開立成功後回寫的**顯示用副本**，唯一真相在 invoices。'
  ' 放這裡是為了讓學員在 /account 看得到自己的發票號碼（invoices 是 service-role only）。'
  ' 只有 finish_invoice_issue() 會寫它，不要在別的地方 update。';
comment on column happyhands.orders.invoice_random_code is '發票隨機碼四碼，對獎用。同樣是副本。';
comment on column happyhands.orders.invoice_issued_at is '開立成功的時間。同樣是副本。';

-- ── 2. invoices：開票的機器 ─────────────────────────────────────────────────

create table if not exists happyhands.invoices (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references happyhands.orders(id) on delete cascade,

  -- Amego 端的唯一鍵。等於 orders.order_no，冪等的地基。
  amego_order_id  text not null,

  status          text not null default 'pending',

  -- 開立成功後的結果
  invoice_number  text,
  random_code     text,
  issued_at       timestamptz,

  -- 送出去的內容（存起來才對得出「當初開的是什麼」）
  buyer_tax_id    text,
  buyer_name      text,
  carrier_type    text,
  carrier_id      text,
  total_amount    int not null check (total_amount >= 0),

  -- 作廢
  voided_at       timestamptz,
  void_reason     text,

  -- 重試機器
  -- 🔴 issue_attempts 由 claim 遞增、**永不歸零**，這是它跟 retry_count 分開的
  --    唯一理由：retry_count 成功時會被重設為 0，用它反推「以前是否送出過」，
  --    等於在最需要反查的那一次（前一次剛好開成功、我們沒記到）選擇不反查。
  issue_attempts  int not null default 0 check (issue_attempts >= 0),
  retry_count     int not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  last_error      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint invoices_amego_order_id_key unique (amego_order_id),
  constraint invoices_status_check check (status in ('pending', 'issuing', 'issued', 'voided'))
);

-- 刻意**不**加 'failed' 狀態：失敗的列一律退回 'pending'，這樣後台的「待開立」
-- 篩選與重試邏輯只要看一個值。失敗的痕跡留在 last_error / retry_count；
-- retry_count 到上限之後 claim 會拒發，等於停在 pending 讓人來處理。
comment on table happyhands.invoices is
  '電子發票（Amego）。一張訂單一列，unique 在 amego_order_id（= orders.order_no）。'
  ' 🔴 開票流程一律 claim_invoice_issue() → 打 Amego → finish/fail，不可以直接 update status。';

comment on column happyhands.invoices.amego_order_id is
  '送給 Amego 的 OrderId，等於 orders.order_no。'
  ' 🔴 必須是對外訂單編號不是內部 uuid —— 它會顯示在 Amego 後台的「訂單編號」，'
  ' 而且是我們反查認回的唯一依據。';
comment on column happyhands.invoices.status is
  'pending=待開立 / issuing=已宣告開立中（可能已送到 Amego）/ issued=已開立 / voided=已作廢。'
  ' 🔴 issuing 不代表失敗，代表「不確定 Amego 那邊有沒有收到」，必須反查才知道。';
comment on column happyhands.invoices.issue_attempts is
  '送出嘗試次數，claim 時遞增，**永不歸零**。> 1 就代表以前送出過，開票前必須先反查 Amego。';
comment on column happyhands.invoices.retry_count is
  '失敗重試次數，成功時歸零。到上限後 claim 會拒發，等人處理。'
  ' ⚠️ 不可以拿它判斷「以前是否送出過」，那是 issue_attempts 的工作。';
comment on column happyhands.invoices.total_amount is
  '開票金額。取 orders.payment_paid_amount ?? orders.total —— 刷卡走 APN 的有實收金額'
  ' 且已驗證與應收相等；ATM／人工那兩種沒有實收欄位，只能用 total。';

create index if not exists idx_invoices_due
  on happyhands.invoices (next_attempt_at)
  where status = 'pending';

create index if not exists idx_invoices_stale
  on happyhands.invoices (claimed_at)
  where status = 'issuing';

create index if not exists idx_invoices_order
  on happyhands.invoices (order_id);

drop trigger if exists trg_invoices_updated_at on happyhands.invoices;
create trigger trg_invoices_updated_at
  before update on happyhands.invoices
  for each row execute function happyhands.set_updated_at();

alter table happyhands.invoices enable row level security;

-- 🔴 刻意不寫任何 grant = service-role only（比照 payment_events、email_outbox）。
--    這裡有錯誤訊息與重試機器，學員看不到也不需要看到；他要的發票號碼已經
--    回寫到 orders 上了。
revoke all on happyhands.invoices from anon, authenticated;

-- ── 3. claim：唯一可以把一列推進 'issuing' 的入口 ───────────────────────────

create or replace function happyhands.claim_invoice_issue(
  p_order_id    uuid,
  p_max_retries int default 8,
  p_stale_after interval default '10 minutes'
)
returns table (
  ok             boolean,
  reason         text,
  invoice_id     uuid,
  amego_order_id text,
  issue_attempts int,
  total_amount   int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv happyhands.invoices%rowtype;
begin
  -- 閘門 1：用訂單列本身當序列化點。
  -- invoices 雖然有 amego_order_id 的 unique，但「同一張訂單被兩個 request
  -- 同時 claim」要擋的是併發不是重複列；鎖訂單列讓兩個 request 排隊。
  -- ⚠️ 刻意**不**在這裡檢查 orders.status = 'paid'：訂單列在這裡只當鎖用。
  --    要不要開票是呼叫端的判斷，這裡多一個條件只會讓卡住的發票更難補開。
  perform 1 from happyhands.orders where id = p_order_id for update;

  select * into v_inv
    from happyhands.invoices
   where order_id = p_order_id
   for update;

  if not found then
    return query select false, 'no_invoice_row'::text, null::uuid, null::text, null::int, null::int;
    return;
  end if;

  if v_inv.status = 'issued' then
    return query select false, 'already_issued'::text, v_inv.id, v_inv.amego_order_id,
                        v_inv.issue_attempts, v_inv.total_amount;
    return;
  end if;

  if v_inv.status = 'voided' then
    return query select false, 'already_voided'::text, v_inv.id, v_inv.amego_order_id,
                        v_inv.issue_attempts, v_inv.total_amount;
    return;
  end if;

  -- 閘門 2：已經有人拿著 claim。只有超過 stale 窗才接手 ——
  -- 接手的人會因為 issue_attempts > 1 而先反查，所以不會重開。
  if v_inv.status = 'issuing'
     and v_inv.claimed_at is not null
     and v_inv.claimed_at > now() - p_stale_after then
    return query select false, 'in_flight'::text, v_inv.id, v_inv.amego_order_id,
                        v_inv.issue_attempts, v_inv.total_amount;
    return;
  end if;

  if v_inv.retry_count >= p_max_retries then
    return query select false, 'retries_exhausted'::text, v_inv.id, v_inv.amego_order_id,
                        v_inv.issue_attempts, v_inv.total_amount;
    return;
  end if;

  if v_inv.next_attempt_at > now() then
    return query select false, 'not_due'::text, v_inv.id, v_inv.amego_order_id,
                        v_inv.issue_attempts, v_inv.total_amount;
    return;
  end if;

  update happyhands.invoices
     set status         = 'issuing',
         claimed_at     = now(),
         issue_attempts = v_inv.issue_attempts + 1
   where id = v_inv.id;

  return query select true, 'claimed'::text, v_inv.id, v_inv.amego_order_id,
                      v_inv.issue_attempts + 1, v_inv.total_amount;
end;
$$;

comment on function happyhands.claim_invoice_issue(uuid, int, interval) is
  '原子地宣告「這張發票由我開」。回 ok=true 才可以呼叫 Amego。'
  ' 🔴 呼叫端拿到 ok=true 之後**一定**要走到 finish_invoice_issue 或 fail_invoice_issue，'
  ' 否則這一列會卡在 issuing 直到 stale 窗過期。'
  ' issue_attempts > 1 代表以前送出過，呼叫端必須先反查 Amego 再決定要不要開。';

-- ── 4. finish：把結果落地，並回寫給客人看的副本 ─────────────────────────────

create or replace function happyhands.finish_invoice_issue(
  p_invoice_id     uuid,
  p_invoice_number text,
  p_random_code    text,
  p_issued_at      timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_existing text;
begin
  select order_id, invoice_number into v_order_id, v_existing
    from happyhands.invoices where id = p_invoice_id for update;

  if not found then
    return false;
  end if;

  -- 🔴 這裡是「一張訂單開出兩張發票」的絆線。
  --    同一列已經有一個**不同的**發票號碼，代表真的多開了一張稅務憑證。
  --    那不是可以 log 一行帶過的事 —— 直接 raise，讓呼叫端的錯誤路徑吵起來。
  if v_existing is not null and v_existing <> p_invoice_number then
    raise exception 'DOUBLE_ISSUE: invoice % already has number % but got %',
      p_invoice_id, v_existing, p_invoice_number;
  end if;

  update happyhands.invoices
     set status         = 'issued',
         invoice_number = p_invoice_number,
         random_code    = p_random_code,
         issued_at      = p_issued_at,
         retry_count    = 0,
         last_error     = null,
         claimed_at     = null
   where id = p_invoice_id;

  -- 顯示用副本，讓學員在 /account 看得到
  update happyhands.orders
     set invoice_number      = p_invoice_number,
         invoice_random_code = p_random_code,
         invoice_issued_at   = p_issued_at
   where id = v_order_id;

  return true;
end;
$$;

comment on function happyhands.finish_invoice_issue(uuid, text, text, timestamptz) is
  '開立成功後落地，同時把號碼回寫到 orders 給客人看。'
  ' 同一列被寫入不同的發票號碼會直接 raise DOUBLE_ISSUE —— 那代表真的多開了一張。';

-- ── 5. fail：退回 pending 等重試 ─────────────────────────────────────────────

create or replace function happyhands.fail_invoice_issue(
  p_invoice_id uuid,
  p_error      text,
  p_permanent  boolean default false,
  p_max_retries int default 8
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_retry int;
  v_backoff_minutes int;
begin
  select retry_count into v_retry
    from happyhands.invoices where id = p_invoice_id for update;

  if not found then
    return false;
  end if;

  v_retry := v_retry + 1;

  -- p_permanent = 統編格式錯、金額算錯這種「重試一萬次還是同一個答案」的，
  -- 直接把 retry_count 推到上限，之後 claim 一律回 retries_exhausted 等人改資料。
  if p_permanent then
    v_retry := p_max_retries;
  end if;

  -- 指數退避，上限 6 小時（跟 email_outbox 同一套）
  v_backoff_minutes := least(360, power(2, least(v_retry, 8))::int);

  update happyhands.invoices
     set status          = 'pending',
         retry_count     = v_retry,
         last_error      = left(coalesce(p_error, ''), 500),
         next_attempt_at = now() + make_interval(mins => v_backoff_minutes),
         claimed_at      = null
   where id = p_invoice_id
     -- 🔴 絕不碰已經開出去的列。發票已經在客人手上了，任何「還原成 pending」
     --    都是在邀請系統再開一張。
     and status <> 'issued'
     and status <> 'voided';

  return true;
end;
$$;

comment on function happyhands.fail_invoice_issue(uuid, text, boolean, int) is
  '開立失敗，退回 pending 等重試（指數退避上限 6 小時）。'
  ' p_permanent=true 直接推到重試上限，用於「重試也不會變」的錯誤（統編格式錯之類）。'
  ' 🔴 status=issued/voided 的列不會被動到。';

-- ── 6. reclaim：把卡在 issuing 的列撿回來 ───────────────────────────────────

create or replace function happyhands.reclaim_stale_invoices(
  p_stale_after interval default '10 minutes'
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update happyhands.invoices
     set status     = 'pending',
         claimed_at = null,
         last_error = coalesce(last_error, '') || ' [reclaimed from issuing]'
   where status = 'issuing'
     and claimed_at is not null
     and claimed_at < now() - p_stale_after;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function happyhands.reclaim_stale_invoices(interval) is
  '把卡在 issuing 超過 stale 窗的列撥回 pending。'
  ' claim 本身就會接手過期的 issuing，所以這支不是正確性必需品，是**可見性**必需品 ——'
  ' 讓後台的「待開立」清單看得到它們。撥回來的列 issue_attempts 仍 > 1，'
  ' 下次開票前一定會先反查，不會重開。';

-- ── 7. 後台告警計數 ─────────────────────────────────────────────────────────

create or replace function happyhands.count_invoice_alerts()
returns table (
  pending_overdue int,  -- 付款超過 30 分鐘還沒開出來的
  stuck_issuing   int,  -- 卡在 issuing 的（不確定 Amego 收到沒）
  exhausted       int   -- 重試用完的
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    (select count(*)::int from happyhands.invoices i
       join happyhands.orders o on o.id = i.order_id
      where i.status = 'pending'
        and o.paid_at is not null
        and o.paid_at < now() - interval '30 minutes'),
    (select count(*)::int from happyhands.invoices
      where status = 'issuing'
        and claimed_at < now() - interval '10 minutes'),
    (select count(*)::int from happyhands.invoices
      where status = 'pending' and retry_count >= 8);
$$;

comment on function happyhands.count_invoice_alerts() is
  '後台總覽的發票異常計數。'
  ' ⚠️ 這支一定要真的被畫面呼叫 —— payment 那邊的 count_payment_alerts() 寫好了'
  ' 卻沒有任何一處呼叫，等於「客人付了錢沒拿到東西」沒有人看得到。不要重蹈覆轍。';

revoke all on function happyhands.claim_invoice_issue(uuid, int, interval) from public, anon, authenticated;
revoke all on function happyhands.finish_invoice_issue(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function happyhands.fail_invoice_issue(uuid, text, boolean, int) from public, anon, authenticated;
revoke all on function happyhands.reclaim_stale_invoices(interval) from public, anon, authenticated;
revoke all on function happyhands.count_invoice_alerts() from public, anon, authenticated;

grant execute on function happyhands.claim_invoice_issue(uuid, int, interval) to service_role;
grant execute on function happyhands.finish_invoice_issue(uuid, text, text, timestamptz) to service_role;
grant execute on function happyhands.fail_invoice_issue(uuid, text, boolean, int) to service_role;
grant execute on function happyhands.reclaim_stale_invoices(interval) to service_role;
grant execute on function happyhands.count_invoice_alerts() to service_role;
-- ===== 20260901000001_payment_alerts.sql =====
set search_path = happyhands, public, extensions;
-- 付款告警：把「有人付了錢卻沒拿到東西」真的變成看得見的數字
--
-- 背景：count_payment_alerts() 在 20260817000001 就寫好了，但
--   (a) 從來沒有任何畫面呼叫它（admin/page.tsx:290 的註解自己就寫了這件事），
--   (b) 它只認 amount_mismatch 與 order_not_found 這兩種 outcome。
--
-- 而 APN handler 真正會產出的失敗狀態遠不只那兩種。原本的幾個 bug
-- （去重把 DB 錯誤當成重複通知、回查失敗後重送被吃掉、金額比對是恆真式）
-- 掉單時留下的 outcome 全都是這支函式看不到的那幾種 ——
-- 等於「掉錢的那條路徑」剛好完全避開了「偵測掉錢的那支查詢」。
--
-- 這個 migration 只改查詢與新增一支函式，不動任何資料。

-- ---------------------------------------------------------------------------
-- 1. 真的出事的（客人付了錢，但東西沒給）
-- ---------------------------------------------------------------------------

create or replace function happyhands.count_payment_alerts()
returns int
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from happyhands.payment_events
  where created_at > now() - interval '30 days'
    and (
      outcome in (
        'amount_mismatch',   -- 實收與應收不符，沒開通
        'not_authorized',    -- 回查黑貓 PAY 說這筆沒授權，沒開通
        'verify_failed',     -- 回查打不通，沒開通
        'reversal_notice'    -- 授權被取消／請款失敗，但訂單還掛在「已收款」
      )
      -- 收到通知卻找不到訂單。
      --
      -- ⚠️ 但要排掉「這則通知本來就跟錢無關」的狀態碼，否則紅框會被雜訊塞滿：
      --    正式站現在就有 5 筆 status_code='D'（訂單逾期）的 order_not_found ——
      --    那是沒人付款的單過期了、而那張單後來被刪掉，一毛錢都沒動到。
      --    這種每天掛在「需要處理」裡，只會把人訓練成不看那一塊。
      --    D 逾期／F 授權失敗／N 取消交易失敗／R 取消授權失敗都屬於這一類；
      --    其餘（含未知的新狀態碼）一律照舊告警，寧可多吵不要漏。
      or (
        outcome = 'order_not_found'
        and status_code not in ('D', 'F', 'N', 'R')
      )
      -- 卡在 pending 超過一小時 = 上次處理到一半就死了，
      -- 而 APN 同一個狀態碼最多重送 3 次（45 分鐘內）也已經用完了。
      or (outcome = 'pending' and created_at < now() - interval '1 hour')
    )
$$;

revoke all on function happyhands.count_payment_alerts() from public, anon, authenticated;
grant execute on function happyhands.count_payment_alerts() to service_role;

comment on function happyhands.count_payment_alerts() is
  '近 30 天「收到付款通知但沒能把東西給出去」的筆數。每一筆都代表客人可能已經付錢 '
  '卻沒拿到課程／席次，必須有人看到 —— 顯示在 /admin 總覽的「需要處理」。';

-- ---------------------------------------------------------------------------
-- 2. 開通了、但金額沒核對過的
-- ---------------------------------------------------------------------------
--
-- 跟上面那支分開，因為嚴重度完全不同：這些訂單的課已經開了、客人沒有受影響，
-- 只是我們沒有一個獨立來源可以證明「他付的錢等於我們要收的錢」。
--
-- 為什麼會有這種狀態：規格只明寫 pay_amount 一個實收金額欄位，而那是代收代付
-- （繳款單）在用的；線上刷卡的 APN 與訂單查詢回應裡到底叫什麼名字，
-- 規格沒說清楚，我們手上也還沒有一筆真實交易可以看。
--
-- 以前的程式碼遇到這種情況是「回退去比對 order_amount」—— 但那是我們自己送出去
-- 的數字，比對永遠成立，等於沒比。現在改成誠實記成沒驗過並列在這裡。
--
-- ⚠️ 第一筆真實刷卡進來之後，payment_events.raw.__query_response 裡就會有完整
--    回應。把 lib/payment/blackcat.ts 的 PAID_AMOUNT_FIELDS 改對之後，
--    這個數字就會回到 0。它一直不是 0 才是正常的「還沒對到欄位名」，不是災難。

create or replace function happyhands.count_payment_unverified()
returns int
language sql
security definer
stable
set search_path = ''
as $$
  select count(*)::int
  from happyhands.payment_events
  where outcome = 'applied_unverified'
    and created_at > now() - interval '30 days'
$$;

revoke all on function happyhands.count_payment_unverified() from public, anon, authenticated;
grant execute on function happyhands.count_payment_unverified() to service_role;

comment on function happyhands.count_payment_unverified() is
  '近 30 天已開通、但沒有獨立金額來源可核對的付款筆數。課已經開了、客人沒事，'
  '是我們這邊少了一個可以證明金額正確的欄位。對帳時人工比對黑貓 PAY 後台即可。';

-- ---------------------------------------------------------------------------
-- 3. outcome 詞彙表更新
-- ---------------------------------------------------------------------------

comment on column happyhands.payment_events.outcome is
  'applied=已開通且金額核對過／applied_unverified=已開通但沒有獨立金額可核對／'
  'ignored=這個狀態碼不觸發開通／amount_mismatch=實收與應收不符（沒開通）／'
  'not_authorized=回查說沒授權（沒開通）／verify_failed=回查失敗（沒開通，會重送）／'
  'order_not_found=找不到訂單／reversal_notice=授權被取消或請款失敗但訂單仍為已收款／'
  'pending=處理中，停在這個值超過一小時代表跑到一半死掉。'
  '⚠️ 去重是以「有沒有跑到終局」為準：applied / applied_unverified / ignored / '
  'amount_mismatch 是終局，其餘的重送時會重跑一次（見 apn/route.ts 的 TERMINAL_OUTCOMES）。';
