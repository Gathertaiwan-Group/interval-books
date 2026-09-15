-- 由 rewrite_schema.py 自動產生，不要手改；改規則請改產生器。
create schema if not exists gooddays;
create schema if not exists gooddays_private;


-- ===== 20260718000001_init.sql =====
set search_path = gooddays, public, extensions;
-- interval 初始 schema:會員、商品、訂單、AI 報價、設定
-- 設計原則(仿 gather-landing / realreal):
--  * 全部資料表開 RLS;公開頁面一律經由 server(service role)以 token 讀取
--  * 會員(profiles)綁 Supabase Auth;admin 以 profiles.role 判斷
--  * AI 報價:AI 只產草稿(status=draft),管理員核准後寄出 token 連結

-- ========== 會員 ==========
create table gooddays.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  phone text,
  line_id text,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 註冊時自動建立 profile
create or replace function gooddays.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = gooddays
as $$
begin
  insert into gooddays.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

-- admin 判斷(security definer 避免 RLS 遞迴)
create or replace function gooddays.is_admin()
returns boolean
language sql
security definer set search_path = gooddays
stable
as $$
  select exists (
    select 1 from gooddays.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ========== 商品 ==========
create table gooddays.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  price integer not null check (price >= 0),          -- TWD 整數
  compare_at_price integer check (compare_at_price >= 0),
  currency text not null default 'TWD',
  images jsonb not null default '[]'::jsonb,           -- [{url, alt}]
  category text not null default '',
  stock integer not null default 0 check (stock >= 0),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  featured boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ========== 訂單 ==========
create sequence gooddays.order_no_seq;

create table gooddays.orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique
    default 'IV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('gooddays.order_no_seq')::text, 5, '0'),
  user_id uuid references gooddays.profiles (id) on delete set null,
  quote_id uuid,                                       -- 由 AI 報價轉單時回填
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'processing', 'shipped', 'completed', 'cancelled')),
  subtotal integer not null default 0,
  shipping_fee integer not null default 0,
  total integer not null default 0,
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  shipping_address text not null default '',
  payment_method text not null default 'bank_transfer'
    check (payment_method in ('bank_transfer', 'cod', 'card', 'other')),
  note text not null default '',
  public_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  paid_at timestamptz,
  shipped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table gooddays.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references gooddays.orders (id) on delete cascade,
  product_id uuid references gooddays.products (id) on delete set null,
  name text not null,                                  -- 下單當下的商品名快照
  unit_price integer not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now()
);

create index order_items_order_id_idx on gooddays.order_items (order_id);
create index orders_user_id_idx on gooddays.orders (user_id);

-- ========== AI 報價 ==========
create sequence gooddays.quote_no_seq;

create table gooddays.quotes (
  id uuid primary key default gen_random_uuid(),
  quote_no text not null unique
    default 'Q-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('gooddays.quote_no_seq')::text, 4, '0'),
  session_id text,
  user_id uuid references gooddays.profiles (id) on delete set null,
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted')),
  line_items jsonb not null default '[]'::jsonb,       -- [{name, unit_price, quantity, note}]
  subtotal integer not null default 0,
  tax integer not null default 0,
  total integer not null default 0,
  valid_until date,
  note text not null default '',
  created_by text not null default 'ai' check (created_by in ('ai', 'manual')),
  public_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  order_id uuid references gooddays.orders (id) on delete set null,
  sent_at timestamptz,
  viewed_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table gooddays.orders
  add constraint orders_quote_id_fkey
  foreign key (quote_id) references gooddays.quotes (id) on delete set null;

-- AI 對話紀錄(每個 session 一列,upsert)
create table gooddays.ai_chat_logs (
  session_id text primary key,
  user_id uuid references gooddays.profiles (id) on delete set null,
  messages jsonb not null default '[]'::jsonb,
  message_count integer not null default 0,
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  intent text not null default '',
  quote_id uuid references gooddays.quotes (id) on delete set null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- AI 用量限流(仿 gather 的 ai_rate_check)
create table gooddays.ai_usage (
  ip text not null,
  day date not null default current_date,
  count integer not null default 0,
  primary key (ip, day)
);

create or replace function gooddays.ai_rate_check(p_ip text, p_ip_limit int, p_global_limit int)
returns boolean
language plpgsql
security definer set search_path = gooddays
as $$
declare
  ip_count int;
  global_count int;
begin
  insert into gooddays.ai_usage (ip, day, count)
  values (p_ip, current_date, 1)
  on conflict (ip, day) do update set count = gooddays.ai_usage.count + 1
  returning count into ip_count;

  select coalesce(sum(count), 0) into global_count
  from gooddays.ai_usage where day = current_date;

  return ip_count <= p_ip_limit and global_count <= p_global_limit;
end;
$$;

-- ========== 設定(費率卡、公司資訊、追蹤參數) ==========
create table gooddays.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ========== RLS ==========
alter table gooddays.profiles enable row level security;
alter table gooddays.products enable row level security;
alter table gooddays.orders enable row level security;
alter table gooddays.order_items enable row level security;
alter table gooddays.quotes enable row level security;
alter table gooddays.ai_chat_logs enable row level security;
alter table gooddays.ai_usage enable row level security;
alter table gooddays.settings enable row level security;

-- profiles:本人可讀寫自己;admin 全部
create policy "profiles_select_own" on gooddays.profiles
  for select using (auth.uid() = id or gooddays.is_admin());
create policy "profiles_update_own" on gooddays.profiles
  for update using (auth.uid() = id or gooddays.is_admin());

-- products:上架商品公開可讀;admin 全部
create policy "products_public_read" on gooddays.products
  for select using (status = 'active' or gooddays.is_admin());
create policy "products_admin_write" on gooddays.products
  for all using (gooddays.is_admin());

-- orders:本人可讀自己的;admin 全部(建立一律走 server service role)
create policy "orders_select_own" on gooddays.orders
  for select using (auth.uid() = user_id or gooddays.is_admin());
create policy "orders_admin_write" on gooddays.orders
  for all using (gooddays.is_admin());

create policy "order_items_select_own" on gooddays.order_items
  for select using (
    exists (
      select 1 from gooddays.orders o
      where o.id = order_id and (o.user_id = auth.uid() or gooddays.is_admin())
    )
  );
create policy "order_items_admin_write" on gooddays.order_items
  for all using (gooddays.is_admin());

-- quotes / ai_chat_logs / ai_usage / settings:僅 admin(公開讀取走 server token 查詢)
create policy "quotes_select_own" on gooddays.quotes
  for select using (auth.uid() = user_id or gooddays.is_admin());
create policy "quotes_admin_write" on gooddays.quotes
  for all using (gooddays.is_admin());
create policy "chat_logs_admin" on gooddays.ai_chat_logs
  for all using (gooddays.is_admin());
create policy "ai_usage_admin" on gooddays.ai_usage
  for all using (gooddays.is_admin());
create policy "settings_admin" on gooddays.settings
  for all using (gooddays.is_admin());

-- ========== updated_at 自動更新 ==========
create or replace function gooddays.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_profiles before update on gooddays.profiles
  for each row execute function gooddays.touch_updated_at();
create trigger touch_products before update on gooddays.products
  for each row execute function gooddays.touch_updated_at();
create trigger touch_orders before update on gooddays.orders
  for each row execute function gooddays.touch_updated_at();
create trigger touch_quotes before update on gooddays.quotes
  for each row execute function gooddays.touch_updated_at();
create trigger touch_chat_logs before update on gooddays.ai_chat_logs
  for each row execute function gooddays.touch_updated_at();
-- ===== 20260719000001_littlemoments.sql =====
set search_path = gooddays, public, extensions;
-- 小時光 Little Moments 改造:商品三模式(藝術/旅程/會員)、點數帳本、會員等級、預約參訪
-- 沿用既有風格(裸 alter/create + RLS 全開;由 provision 的 _migrations 表去重,不需 IF NOT EXISTS)

-- ========== products 擴充(藝術品 / 旅程 / 會員方案 三模式) ==========
alter table gooddays.products add column product_type text not null default 'artwork'
  check (product_type in ('artwork', 'journey', 'membership'));
alter table gooddays.products add column price_rental_monthly integer; -- 月租價(僅 artwork)
alter table gooddays.products add column points_price integer;          -- 可折抵點數(journey 用)
alter table gooddays.products add column metadata jsonb not null default '{}'::jsonb;

-- ========== order_items 購買模式 ==========
alter table gooddays.order_items add column purchase_mode text not null default 'buyout'
  check (purchase_mode in ('buyout', 'rental', 'journey', 'membership'));
alter table gooddays.order_items add column tier_slug text; -- membership 商品對應等級

-- ========== orders 點數 ==========
alter table gooddays.orders add column points_used integer not null default 0 check (points_used >= 0);
alter table gooddays.orders add column points_earned integer not null default 0 check (points_earned >= 0);

-- ========== profiles 會員等級 ==========
alter table gooddays.profiles add column tier_slug text;
alter table gooddays.profiles add column tier_expires_at timestamptz;

-- ========== 會員等級表 ==========
create table gooddays.membership_tiers (
  slug text primary key,
  name text not null,
  price_yearly integer not null check (price_yearly >= 0), -- 年費(TWD)
  rebate_rate numeric not null check (rebate_rate >= 0),    -- 消費回饋 %(每消費 NT$100 累點數 = rebate_rate)
  perks jsonb not null default '[]'::jsonb,
  sort int not null default 0
);

-- ========== 點數帳本(仿 realreal points_ledger) ==========
create table gooddays.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references gooddays.profiles (id) on delete cascade,
  delta integer not null,
  source text not null check (source in ('earn', 'redeem', 'expire', 'refund', 'manual_adjust', 'promo')),
  source_ref_id text,
  note text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- 冪等關鍵:同一 (user, source, source_ref_id) 只能存在一筆(earn 對應訂單、expire 對應原 earn id 等)
create unique index points_ledger_dedupe on gooddays.points_ledger (user_id, source, source_ref_id)
  where source_ref_id is not null;
create index points_ledger_user_id_idx on gooddays.points_ledger (user_id, created_at desc);

create view gooddays.v_user_points_balance as
  select user_id, coalesce(sum(delta), 0)::int as balance
  from gooddays.points_ledger
  group by user_id;

-- 可到期沖銷的 earn 批次(尚未寫過對應 expire 的):worker 排程用,避免每次全表掃描已處理過的紀錄
create view gooddays.v_expirable_earn_points as
  select e.id, e.user_id, e.delta
  from gooddays.points_ledger e
  where e.source = 'earn'
    and e.expires_at is not null
    and e.expires_at < now()
    and not exists (
      select 1 from gooddays.points_ledger x
      where x.source = 'expire' and x.source_ref_id = e.id::text
    );

-- ========== 預約參訪 ==========
create table gooddays.bookings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  visit_date date,
  purpose text,
  message text,
  status text not null default 'new' check (status in ('new', 'confirmed', 'done', 'cancelled')),
  created_at timestamptz not null default now()
);

create index bookings_created_at_idx on gooddays.bookings (created_at desc);

-- ========== 跨表外鍵(等 membership_tiers 建立後補上,仿既有 orders_quote_id_fkey 寫法) ==========
alter table gooddays.order_items
  add constraint order_items_tier_slug_fkey
  foreign key (tier_slug) references gooddays.membership_tiers (slug) on delete set null;
alter table gooddays.profiles
  add constraint profiles_tier_slug_fkey
  foreign key (tier_slug) references gooddays.membership_tiers (slug) on delete set null;

-- ========== RLS ==========
alter table gooddays.membership_tiers enable row level security;
alter table gooddays.points_ledger enable row level security;
alter table gooddays.bookings enable row level security;

-- membership_tiers:公開讀,admin 寫
create policy "membership_tiers_public_read" on gooddays.membership_tiers
  for select using (true);
create policy "membership_tiers_admin_write" on gooddays.membership_tiers
  for all using (gooddays.is_admin());

-- points_ledger:本人(或 admin)可讀;寫入一律走 service role(不開放任何角色的 insert/update/delete policy)
create policy "points_ledger_select_own" on gooddays.points_ledger
  for select using (auth.uid() = user_id or gooddays.is_admin());

-- bookings:任何人(含匿名)可 insert,admin 可全部操作
create policy "bookings_public_insert" on gooddays.bookings
  for insert with check (true);
create policy "bookings_admin_all" on gooddays.bookings
  for all using (gooddays.is_admin());
-- ===== 20260720000001_checkout_v2.sql =====
set search_path = gooddays, public, extensions;
-- 小時光二期:購物車 flyout + 結帳強化(收件方式/發票/轉帳強化) + 運費設定 + Idempotency-Key
-- 沿用既有風格(裸 alter/create + RLS 全開;由 provision 的 _migrations 表去重,不需 IF NOT EXISTS)。
-- orders 既有 RLS policy(orders_admin_write 全靠 service role 寫入)已涵蓋新欄位,不需額外 RLS。

-- ========== orders 擴充 ==========
alter table gooddays.orders add column shipping_method text not null default 'home'
  check (shipping_method in ('home', 'pickup', 'none'));
alter table gooddays.orders add column invoice jsonb not null default '{}'::jsonb; -- {type:'personal'|'company', carrier?, tax_id?, title?}
alter table gooddays.orders add column payment_report jsonb; -- {last5, reported_at}(客戶回報匯款末五碼)
alter table gooddays.orders add column idempotency_key text unique;
-- ===== 20260720000002_pchomepay.sql =====
set search_path = gooddays, public, extensions;
-- 小時光:PChomePay 支付連(信用卡/ATM/超商代碼)金流
-- 沿用既有風格(裸 alter/create + RLS;由 provision 的 _migrations 表去重,不需 IF NOT EXISTS)。

-- ========== orders:金流欄位 ==========
alter table gooddays.orders add column gateway text; -- 金流商代碼,如 'pchomepay'(NULL = 站內流程,無外部金流)
alter table gooddays.orders add column gateway_tx_id text; -- 對應金流商的訂單編號(PChomePay 即 order_no 本身)

-- 同一筆金流訂單編號只會對到一筆 interval 訂單;NULL(非 card 付款)不受此限制。
create unique index orders_gateway_tx_id_idx on gooddays.orders (gateway_tx_id) where gateway_tx_id is not null;

-- ========== webhook_events:金流 webhook 標記 ==========
-- event_key 慣例:目前只寫 failed_<order_no> —— 供 /api/orders/status 判斷付款失敗
-- (interval 的 orders.status 沒有獨立的 failed 狀態,不能直接寫回 orders,見 webhook route 註解)。
-- 付款成功的冪等改由 markOrderPaid 的條件式 update(CAS on status='pending')保證,不再用
-- 本表做預佔式去重(舊設計會被偽造通知搶佔 key 卡單,已於 2026-07-19 安全稽核後移除)。
-- unique(gateway,event_key) 仍保留,讓並發的 failed marker 寫入自然去重。
create table gooddays.webhook_events (
  id uuid primary key default gen_random_uuid(),
  gateway text not null,
  event_key text not null,
  created_at timestamptz not null default now(),
  unique (gateway, event_key)
);

alter table gooddays.webhook_events enable row level security;
-- 僅供後台除錯查閱;寫入一律經由 service role(webhook / server action),繞過 RLS。
create policy "webhook_events_admin_read" on gooddays.webhook_events
  for select using (gooddays.is_admin());
-- ===== 20260720000003_chat_uploads_private.sql =====
set search_path = gooddays, public, extensions;
-- chat-uploads 轉為私密:客戶家中照片不應可被任意人以公開網址存取。
-- 讀取一律改走短期簽名網址(伺服器端以 service role 產生)。
update storage.buckets set public = false where id = 'chat-uploads';
-- ===== 20260722000001_rename_to_goodays.sql =====
set search_path = gooddays, public, extensions;
-- 品牌改名:小時光 Little Moments → 好日子 Good Days
-- 只更新 company_profile 中含舊名的欄位(name/email/address);tagline/hours/phone 不含舊名,保留原值。
-- 重佈建(provision.mjs 重跑或新環境)時,20260719000001_littlemoments.sql 仍會先種下舊名,
-- 靠這支後續 migration 蓋掉,維持與正式環境一致。
update gooddays.settings
set value = value
  || jsonb_build_object(
    'name', '好日子 Good Days',
    'email', 'salon@goodays.tw',
    'address', '台北市大安區　好日子書店'
  )
where key = 'company_profile';
-- ===== 20260722000002_product_i18n.sql =====
set search_path = gooddays, public, extensions;
-- Phase D1:商品內容英文欄位(AI 翻譯管線的資料層)
--
-- 只加欄位、default null,不動任何既有資料——對中文站與後台零風險:
--   * products.name_en / description_en:作品/旅程/會員方案商品的英文名稱與描述
--     (product_type='artwork'|'journey'|'membership' 共用同一張表)。
--   * membership_tiers.name_en / perks_en:會員等級英文名稱與英文權益陣列
--     (perks_en 陣列順序需與中文 perks 一一對應,由 scripts/translate-products.mjs 保證)。
--   * journey 的天數(如「四天三夜」)不需改 schema,英文版寫進既有 products.metadata
--     jsonb 的 duration_en 鍵,與 duration 平行存放。
--
-- 渲染端一律 `locale === 'en' ? (name_en ?? name) : name`:未翻譯時自動 fallback 中文,
-- 中文站(locale=zh)永遠走 name/description/perks 原欄位,逐字不變。
--
-- 用 add column if not exists 確保重跑此檔冪等(即使 provision 的 _migrations 表去重機制
-- 之外被重複執行,也不會因欄位已存在而報錯)。

alter table gooddays.products add column if not exists name_en text;
alter table gooddays.products add column if not exists description_en text;

alter table gooddays.membership_tiers add column if not exists name_en text;
alter table gooddays.membership_tiers add column if not exists perks_en jsonb;
-- ===== 20260722000003_order_locale.sql =====
set search_path = gooddays, public, extensions;
-- Phase F1:orders 加 locale 欄位(通知信英文化的資料層)
--
-- 只加欄位、default 'zh'、不動任何既有資料——對中文站與後台零風險:
--   * orders.locale:下單當下的買家介面語系('zh'|'en',checkout API 依 useTranslations()
--     取得的 locale 寫入,未帶值一律 'zh')。既有訂單全部自動補為 'zh',行為與現在完全相同。
--
-- 通知信(訂單確認/付款確認/出貨等)依此欄位決定 subject/body 中英文分支;
-- notifyAdmin(給店主的信)固定中文,不讀這個欄位。
--
-- 用 add column if not exists 確保重跑此檔冪等。

alter table gooddays.orders add column if not exists locale text not null default 'zh';
-- ===== 20260722000004_quote_locale.sql =====
set search_path = gooddays, public, extensions;
-- 報價 email 英文化的資料層:quotes 加 locale 欄位
--
-- 只加欄位、default 'zh'、不動任何既有資料——對中文站與後台零風險:
--   * quotes.locale:報價草稿建立當下的客戶介面語系('zh'|'en')。AI 對話觸發
--     createQuoteDraftFromSession 時,依 /api/chat 收到的 locale 寫入;未帶值一律 'zh'。
--     既有報價全部自動補為 'zh',寄信行為與現在完全相同。
--
-- 客戶信(報價備妥通知 sendQuoteToCustomer、接受報價後的訂單成立信 acceptQuoteByToken)
-- 依此欄位決定 subject/body 中英文分支;notifyAdmin(給店主的信)固定中文,不讀這個欄位。
--
-- 用 add column if not exists 確保重跑此檔冪等。

alter table gooddays.quotes add column if not exists locale text not null default 'zh';
-- ===== 20260723000001_courses.sql =====
set search_path = gooddays, public, extensions;
-- 課程系統
--   報名型課程(live):有日期、有名額上限,可免費報名或付費報名
--   線上預錄課程(recorded):付費購買後可觀看多支 YouTube 單元影片
--
-- 設計:沿用 products(product_type='course')以繼承既有金流、點數折抵、
--      後端查價防篡改與購物車;課程專屬資料放以下四張子表。
--
-- 慣例:裸 DDL(由 scripts/provision.mjs 的 _migrations 表去重,每檔只跑一次)。
--      整檔由 Management API 一次送出,語法錯誤會整份 rollback。

-- ========== 既有 CHECK 放寬 ==========
-- 注意:這兩個 CHECK 是匿名宣告的(add column ... check(...)),名稱由 Postgres
-- 自動生成。用 if exists 避免名稱不符時整份 migration 卡死。
alter table gooddays.products drop constraint if exists products_product_type_check;
alter table gooddays.products add constraint products_product_type_check
  check (product_type in ('artwork', 'journey', 'membership', 'course'));

alter table gooddays.order_items drop constraint if exists order_items_purchase_mode_check;
alter table gooddays.order_items add constraint order_items_purchase_mode_check
  check (purchase_mode in ('buyout', 'rental', 'journey', 'membership', 'course'));

-- ========== 課程細節(與 products 一對一) ==========
create table gooddays.course_details (
  product_id uuid primary key references gooddays.products (id) on delete cascade,
  course_kind text not null check (course_kind in ('live', 'recorded')),
  enrollment_type text not null default 'paid' check (enrollment_type in ('free', 'paid')),
  instructor text not null default '',
  outline text not null default '',
  location text not null default '',
  starts_at timestamptz,
  ends_at timestamptz,
  enroll_deadline timestamptz,
  -- null = 不限名額
  capacity integer check (capacity is null or capacity > 0),
  -- 只能經由本檔的 SQL function 異動,直接 update 會讓名額失準
  seats_taken integer not null default 0 check (seats_taken >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 預錄課程沒有免費報名與名額的概念
  constraint course_details_recorded_is_paid
    check (course_kind = 'live' or enrollment_type = 'paid'),
  constraint course_details_recorded_no_cap
    check (course_kind = 'live' or capacity is null)
);
create index course_details_starts_at_idx on gooddays.course_details (starts_at);

-- ========== 課程單元影片 ==========
-- 只存 11 碼 YouTube video id,不存完整網址:
--   1. ?t= / &list= / &si= 等參數帶進 iframe 會出錯
--   2. 統一格式才能加 CHECK 正規式
-- 本表刻意不開放公開讀(見下方 RLS),影片 id 只由伺服器在驗證購買後吐出。
create table gooddays.course_lessons (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references gooddays.products (id) on delete cascade,
  title text not null,
  description text not null default '',
  youtube_video_id text not null check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  is_preview boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index course_lessons_product_idx on gooddays.course_lessons (product_id, sort_order);

-- ========== 報名紀錄 ==========
-- 免費報名:order_id 為 null,建立時即 confirmed
-- 付費報名:建單(pending)時先佔位為 reserved 並設 expires_at,付款後轉 confirmed
create table gooddays.course_enrollments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references gooddays.products (id) on delete cascade,
  user_id uuid not null references gooddays.profiles (id) on delete cascade,
  order_id uuid references gooddays.orders (id) on delete set null,
  status text not null default 'reserved'
    check (status in ('reserved', 'confirmed', 'cancelled')),
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  note text not null default '',
  expires_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
-- 同一人同一堂課只能有一筆有效報名(取消後可重報)
create unique index course_enrollments_active_uniq
  on gooddays.course_enrollments (product_id, user_id) where status <> 'cancelled';
create index course_enrollments_product_idx on gooddays.course_enrollments (product_id, created_at desc);
create index course_enrollments_user_idx on gooddays.course_enrollments (user_id, created_at desc);
create index course_enrollments_order_idx on gooddays.course_enrollments (order_id);
create index course_enrollments_expiry_idx on gooddays.course_enrollments (expires_at)
  where status = 'reserved';

-- ========== 觀看權 ==========
-- 本專案原本沒有任何 entitlement 機制(profiles.tier_slug 是單值欄位,
-- 存不了多堂課),故新建本表。
create table gooddays.course_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references gooddays.profiles (id) on delete cascade,
  product_id uuid not null references gooddays.products (id) on delete cascade,
  source text not null check (source in ('purchase', 'enrollment', 'manual')),
  source_ref_id text,
  note text not null default '',
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index course_access_user_product_uniq
  on gooddays.course_access (user_id, product_id);
create index course_access_user_idx on gooddays.course_access (user_id) where revoked_at is null;

-- ========== 名額控制 ==========
-- 一律經由以下 function 異動 seats_taken。全部先對 course_details 該列
-- 下 FOR UPDATE 列鎖,把同一堂課的報名交易序列化,不可能超賣。
-- (不用 count(*) 判斷:read committed 下兩個交易會同時數到 n-1 而雙雙通過)

create or replace function gooddays.reserve_course_seat(
  p_product_id uuid,
  p_user_id uuid,
  p_order_id uuid,
  p_confirmed boolean,
  p_expires_at timestamptz,
  p_name text,
  p_email text,
  p_phone text
) returns text
language plpgsql
security definer
set search_path = gooddays
as $$
declare
  v_cap int;
  v_taken int;
  v_existing text;
begin
  select capacity, seats_taken into v_cap, v_taken
    from gooddays.course_details
    where product_id = p_product_id
    for update;                       -- 併發在此序列化
  if not found then
    return 'not_course';
  end if;

  select status into v_existing
    from gooddays.course_enrollments
    where product_id = p_product_id and user_id = p_user_id and status <> 'cancelled';
  if found then
    return 'already_enrolled';
  end if;

  if v_cap is not null and v_taken >= v_cap then
    return 'full';
  end if;

  insert into gooddays.course_enrollments
    (product_id, user_id, order_id, status, expires_at, confirmed_at,
     contact_name, contact_email, contact_phone)
  values
    (p_product_id, p_user_id, p_order_id,
     case when p_confirmed then 'confirmed' else 'reserved' end,
     case when p_confirmed then null else p_expires_at end,
     case when p_confirmed then now() else null end,
     coalesce(p_name, ''), coalesce(p_email, ''), coalesce(p_phone, ''));

  update gooddays.course_details
    set seats_taken = seats_taken + 1, updated_at = now()
    where product_id = p_product_id;

  return 'ok';
end;
$$;

-- 付款成功後把該訂單的保留位轉為確認。
-- 若保留期已被排程回收(客人拖太久才匯款),嘗試重新搶位;搶不到回 'full',
-- 由呼叫端通知後台人工處理 —— 但絕不因此中斷收款流程。
create or replace function gooddays.confirm_course_seats_for_order(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = gooddays
as $$
declare
  r record;
  v_cap int;
  v_taken int;
  v_result text := 'ok';
begin
  for r in
    select id, product_id, status
      from gooddays.course_enrollments
      where order_id = p_order_id and status <> 'confirmed'
      order by created_at
  loop
    if r.status = 'reserved' then
      update gooddays.course_enrollments
        set status = 'confirmed', confirmed_at = now(), expires_at = null
        where id = r.id and status = 'reserved';
    else
      -- 已被回收(cancelled),重新搶位
      select capacity, seats_taken into v_cap, v_taken
        from gooddays.course_details where product_id = r.product_id for update;
      if v_cap is not null and v_taken >= v_cap then
        v_result := 'full';
        continue;
      end if;
      begin
        update gooddays.course_enrollments
          set status = 'confirmed', confirmed_at = now(),
              expires_at = null, cancelled_at = null
          where id = r.id;
        update gooddays.course_details
          set seats_taken = seats_taken + 1, updated_at = now()
          where product_id = r.product_id;
      exception when unique_violation then
        v_result := 'duplicate';
      end;
    end if;
  end loop;
  return v_result;
end;
$$;

-- 取消訂單時退位
create or replace function gooddays.release_course_seats_for_order(p_order_id uuid)
returns int
language plpgsql
security definer
set search_path = gooddays
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, product_id from gooddays.course_enrollments
      where order_id = p_order_id and status <> 'cancelled'
  loop
    perform 1 from gooddays.course_details where product_id = r.product_id for update;
    update gooddays.course_enrollments
      set status = 'cancelled', cancelled_at = now() where id = r.id;
    update gooddays.course_details
      set seats_taken = greatest(seats_taken - 1, 0), updated_at = now()
      where product_id = r.product_id;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 排程回收逾期未付款的保留位(由 api/src/jobs.ts 每小時呼叫)
create or replace function gooddays.expire_course_reservations()
returns int
language plpgsql
security definer
set search_path = gooddays
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select id, product_id from gooddays.course_enrollments
      where status = 'reserved' and expires_at is not null and expires_at < now()
  loop
    perform 1 from gooddays.course_details where product_id = r.product_id for update;
    update gooddays.course_enrollments
      set status = 'cancelled', cancelled_at = now()
      where id = r.id and status = 'reserved';
    if found then
      update gooddays.course_details
        set seats_taken = greatest(seats_taken - 1, 0), updated_at = now()
        where product_id = r.product_id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ⚠️ 安全關鍵:security definer 函式預設 PUBLIC 可 EXECUTE,
-- anon 拿 anon key 直接打 PostgREST /rest/v1/rpc/ 就能代任意 user_id 報名。
-- 必須收回權限,只留 service_role(即 createAdminClient() 走的身分)。
--
-- ⚠️⚠️ 「revoke from public」不夠! Supabase 另外設了
--   alter default privileges in schema gooddays grant execute on functions to anon, authenticated
-- 這是給「具名角色」的獨立授權,revoke from public 收不到它。
-- 實測結果:只 revoke public 時 pg_proc.proacl 仍是
--   anon=X/postgres | authenticated=X/postgres  ← 洞還在
-- 所以下面三個對象缺一不可。改動本段前請先讀這段註解。
revoke execute on function gooddays.reserve_course_seat(uuid, uuid, uuid, boolean, timestamptz, text, text, text) from public, anon, authenticated;
revoke execute on function gooddays.confirm_course_seats_for_order(uuid) from public, anon, authenticated;
revoke execute on function gooddays.release_course_seats_for_order(uuid) from public, anon, authenticated;
revoke execute on function gooddays.expire_course_reservations() from public, anon, authenticated;

grant execute on function gooddays.reserve_course_seat(uuid, uuid, uuid, boolean, timestamptz, text, text, text) to service_role;
grant execute on function gooddays.confirm_course_seats_for_order(uuid) to service_role;
grant execute on function gooddays.release_course_seats_for_order(uuid) to service_role;
grant execute on function gooddays.expire_course_reservations() to service_role;

-- ========== RLS ==========
alter table gooddays.course_details enable row level security;
alter table gooddays.course_lessons enable row level security;
alter table gooddays.course_enrollments enable row level security;
alter table gooddays.course_access enable row level security;

create policy "course_details_public_read" on gooddays.course_details
  for select using (
    exists (select 1 from gooddays.products p where p.id = product_id and p.status = 'active')
    or gooddays.is_admin()
  );
create policy "course_details_admin_write" on gooddays.course_details
  for all using (gooddays.is_admin());

-- 刻意不開放任何公開讀:影片 id 只能由伺服器(service role)在驗證購買後吐出
create policy "course_lessons_admin_all" on gooddays.course_lessons
  for all using (gooddays.is_admin());

create policy "course_enrollments_select_own" on gooddays.course_enrollments
  for select using (auth.uid() = user_id or gooddays.is_admin());
create policy "course_enrollments_admin_write" on gooddays.course_enrollments
  for all using (gooddays.is_admin());

-- 仿 points_ledger:只給 select own,寫入一律由 service role 經 function 執行
create policy "course_access_select_own" on gooddays.course_access
  for select using (auth.uid() = user_id or gooddays.is_admin());

-- ========== trigger ==========
create trigger touch_course_details before update on gooddays.course_details
  for each row execute function gooddays.touch_updated_at();
create trigger touch_course_lessons before update on gooddays.course_lessons
  for each row execute function gooddays.touch_updated_at();
-- ===== 20260806000001_course_landing.sql =====
set search_path = gooddays, public, extensions;
-- 課程「完整活動頁」所需欄位
--
-- 設計判斷:固定欄位,不做彈性區塊表(course_sections)。
--   版型是需求寫死的 7 個區塊,不是任意組合。彈性區塊表要配一整套後台 CRUD
--   (新增/刪除/排序/型別切換/每型別不同欄位),而本專案的表單慣例是
--   「非受控 + Server Action」,承載動態列表得另做子頁面,與「現在就能用」衝突。
--   固定欄位只是 CourseForm 多幾個 textarea。代價:未來加區塊要再開 migration。
--
-- _en 欄位一次加齊:事後補要再開 migration + 改 types + 改表單 + 改渲染,
-- 同一件事做兩次。後台把英文欄位收進 <details> 摺疊區,不會讓表單看起來爆炸。
-- 一律 not null default '' —— localizeText() 對空白字串會 fallback 中文,
-- 行為與 products.name_en 的 nullable 相同但處理更簡單。
--
-- ⚠️ _migrations 表與實際 schema 不同步(有人直接在 Dashboard 跑過 SQL),
--    本檔手動單獨執行、不可跑 provision.mjs。故一律 if not exists,重跑安全。

alter table gooddays.course_details
  add column if not exists subtitle             text not null default '',
  add column if not exists subtitle_en          text not null default '',
  add column if not exists pain_points          text not null default '',
  add column if not exists pain_points_en       text not null default '',
  add column if not exists benefits             text not null default '',
  add column if not exists benefits_en          text not null default '',
  add column if not exists outline_en           text not null default '',
  add column if not exists location_en          text not null default '',
  add column if not exists instructor_title     text not null default '',
  add column if not exists instructor_title_en  text not null default '',
  add column if not exists instructor_bio       text not null default '',
  add column if not exists instructor_bio_en    text not null default '',
  add column if not exists instructor_photo_url text not null default '',
  add column if not exists fee_note             text not null default '',
  add column if not exists fee_note_en          text not null default '',
  add column if not exists faq                  jsonb not null default '[]'::jsonb;

-- faq 形狀 [{q, a, q_en, a_en}]。
-- 只擋「必須是陣列」:逐項驗 CHECK 會讓後台任何小格式錯誤變成 500,
-- 而寫入端(server action)已經先清洗過一次。
alter table gooddays.course_details drop constraint if exists course_details_faq_is_array;
alter table gooddays.course_details add constraint course_details_faq_is_array
  check (jsonb_typeof(faq) = 'array');
-- ===== 20260806000002_product_images_bucket.sql =====
set search_path = gooddays, public, extensions;

-- ===== 20260809000001_atomic_deduct_product_stock.sql =====
set search_path = gooddays, public, extensions;
-- 修復商品庫存超賣(見 web/src/app/api/orders/route.ts 扣庫存段落)。
--
-- 舊實作的兩個疊在一起的缺陷:
--   1. 在建單流程前段讀出 products.stock 快照,數百行後才用「絕對值」寫回
--        update products set stock = <快照 - qty> where id = ? and stock >= qty
--      快照時間與寫回時間之間可能已被其他訂單改動,不是真正的併發安全寫法。
--   2. 更嚴重:那句 update 的回傳值完全沒接、沒檢查 error/count——guard 沒擋到時
--      (或根本沒發動保護)訂單照樣成立、照樣導去金流收錢,是「靜默超賣」的來源。
--
-- 新作法比照本專案課程座位 reserve_course_seat()(20260723000001_courses.sql):
-- 對要扣的商品排序後 FOR UPDATE 鎖列,把同一批商品的併發扣庫存交易序列化;
-- 鎖到之後一律用「相對扣減」(set stock = stock - qty where stock >= qty),
-- 任何一筆 ROW_COUNT = 0 就 RAISE EXCEPTION,讓整個 function 呼叫(單一交易)
-- 全部回滾,不留半扣狀態——多品項訂單全有或全無。
--
-- 鎖列順序:所有呼叫一律用「商品 id 排序」取鎖,避免兩張訂單各自以相反順序
-- 鎖兩件相同商品而互相等待造成死鎖。
--
-- 呼叫端(web/src/app/api/orders/route.ts)必須檢查這支 RPC 回傳的 error;
-- 扣不到庫存時要把剛建立的訂單整張刪除、回 409,不能讓訂單留在「已成立」
-- 但庫存沒真的扣到的狀態。
--
-- 參考:Realreal atomic_deduct_stock()(packages/db/migrations/0028_audit_foundation.sql)。

create or replace function gooddays.deduct_product_stock(p_items jsonb)
returns boolean
language plpgsql
security definer
set search_path = gooddays
as $$
declare
  v_ids      uuid[];
  v_rec      record;
  v_affected int;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return true;
  end if;

  -- 排序後取鎖,所有呼叫都用同一順序,避免死鎖
  select array_agg((elem->>'product_id')::uuid order by (elem->>'product_id')::uuid)
    into v_ids
    from jsonb_array_elements(p_items) as elem;

  perform 1
    from gooddays.products
    where id = any(v_ids)
    order by id
    for update;

  -- 逐項相對扣減;任何一項扣不到就整批回滾(拋出例外會讓整個 function 呼叫
  -- 所在的交易 abort,前面已成功的扣減一併撤銷)
  for v_rec in
    select (elem->>'product_id')::uuid as pid,
           (elem->>'quantity')::int    as qty
      from jsonb_array_elements(p_items) as elem
  loop
    update gooddays.products
      set stock = stock - v_rec.qty
      where id = v_rec.pid
        and stock >= v_rec.qty;
    get diagnostics v_affected = row_count;
    if v_affected = 0 then
      raise exception 'insufficient stock for product %', v_rec.pid using errcode = 'P0001';
    end if;
  end loop;

  return true;
end;
$$;

-- ⚠️ 安全關鍵:比照 reserve_course_seat() 已踩過的坑——security definer 函式
-- 預設 PUBLIC 可 EXECUTE,且 Supabase 另外對 anon/authenticated 有
-- alter default privileges 授權,只 revoke from public 收不到,三個對象缺一不可,
-- 否則任何拿 anon key 的人可以直接打
-- /rest/v1/rpc/deduct_product_stock 任意扣光別人商品的庫存。
revoke execute on function gooddays.deduct_product_stock(jsonb) from public, anon, authenticated;
grant execute on function gooddays.deduct_product_stock(jsonb) to service_role;
-- ===== 20260819000001_security_hardening.sql =====
set search_path = gooddays, public, extensions;
-- 修掉 Supabase Security Advisor 的項目,外加一個 advisor 沒抓到、但實際更嚴重的外洩。
--
-- ⚠️ 本檔手動單獨執行,不可跑 provision.mjs(_migrations 與實際 schema 早已不同步,
--    會重跑舊檔撞「already exists」)。執行後手動 insert 進 _migrations。
--
-- 【advisor 沒標、但最嚴重的一項】
-- v_user_points_balance / v_expirable_earn_points 建立時沒有指定 security_invoker,
-- 因此是 SECURITY DEFINER view(以 owner=postgres 的權限執行),而 anon/authenticated
-- 又被授了 ALL。實測(全部在 rollback 的交易內驗證):
--    anon 讀 points_ledger              → 0 筆        (RLS 有擋)
--    anon 讀 v_user_points_balance      → 2 位使用者的餘額全出來(RLS 被繞過)
--    anon 透過 v_expirable_earn_points DELETE → 真的刪掉 points_ledger 的列
-- 也就是:只要有公開的 anon key,任何人都能讀走全站點數餘額,並刪除點數紀錄。

-- 1) view 改成以呼叫者權限執行,並收回 anon/authenticated 的授權。
--    app 端三個消費點全部走 service_role(BYPASSRLS),不受影響:
--      web/src/lib/points.ts          createAdminClient()
--      web/src/app/admin/members/     createAdminClient()
--      api/src/jobs.ts                SUPABASE_SERVICE_ROLE_KEY
alter view gooddays.v_user_points_balance   set (security_invoker = on);
alter view gooddays.v_expirable_earn_points set (security_invoker = on);
revoke all on gooddays.v_user_points_balance   from public, anon, authenticated;
revoke all on gooddays.v_expirable_earn_points from public, anon, authenticated;

-- 3) touch_updated_at 鎖 search_path。函式體只用到 now()(pg_catalog,永遠隱含在
--    search_path 最前面),所以空字串就夠,不需要保留 public。
alter function gooddays.touch_updated_at() set search_path = '';

-- 4) 收回兩個不該從 PostgREST 打得到的 SECURITY DEFINER 函式。
--    ⚠️⚠️ 一定要含 public。proacl 裡的 `=X/postgres` 就是 PUBLIC 的授權,
--         只寫 revoke ... from anon, authenticated 完全沒有效果(已實測:revoke 後
--         anon 照樣呼叫得到)。這與 reserve_course_seat 當初踩的是同一個坑的反面。
--
--    ai_rate_check   目前任何人都能打 /rest/v1/rpc/ai_rate_check,灌爆全站每日 3000 次
--                    AI 額度,或拿別人的 IP 去把對方的每日 60 次打完鎖死。
--                    呼叫端只有 web/src/app/api/chat/route.ts 與 .../chat/mockup/route.ts,
--                    兩支都用 tryCreateAdminClient()(service_role)。
--    handle_new_user auth.users 的 trigger function。trigger 觸發不需要呼叫者持有
--                    EXECUTE(Postgres 在 CREATE TRIGGER 當下就檢查完),收回安全。
revoke execute on function gooddays.ai_rate_check(text, int, int) from public, anon, authenticated;
revoke execute on function gooddays.handle_new_user()             from public, anon, authenticated;
-- ===== 20260819000002_is_admin_private_schema.sql =====
set search_path = gooddays, public, extensions;
-- 把 is_admin() 從 public 搬到 PostgREST 不曝露的 private schema。
--
-- 為什麼不能照 advisor 字面「revoke EXECUTE」:實測過,revoke 之後
--   以 anon 執行 select count(*) from gooddays.products
--   → ERROR 42501 permission denied for function is_admin
-- 因為 is_admin() 被 23 條 RLS policy 引用,RLS 運算式會以查詢者身分求值,
-- 少了 EXECUTE 等於整個前台商店直接死。(WARN 本身也寫 "if that is not intentional")
--
-- 也不能改成 SECURITY INVOKER:is_admin() 讀 gooddays.profiles,而 profiles 的
-- profiles_select_own policy 又是 (auth.uid() = id) OR is_admin() → 無限遞迴。
--
-- 唯一乾淨解:搬到 private schema。anon/authenticated 仍持有 USAGE + EXECUTE
-- (policy 需要),但 PostgREST 的 db-schemas 只有 public / graphql_public,
-- 打不到 /rest/v1/rpc/is_admin,advisor 的 0028/0029 也只掃曝露的 schema。

create schema if not exists gooddays_private;
revoke all on schema gooddays_private from public;
grant usage on schema gooddays_private to anon, authenticated, service_role;

create or replace function gooddays_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path to gooddays
as $$
  select exists (
    select 1 from gooddays.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function gooddays_private.is_admin() from public;
grant execute on function gooddays_private.is_admin() to anon, authenticated, service_role;

-- 以下 23 條逐字取自改動前的 pg_policies.qual,只把 is_admin() 換成
-- gooddays_private.is_admin(),其餘一字未動。全部都是 PERMISSIVE、roles={public}、
-- 且只有 USING 沒有 WITH CHECK,所以 ALTER POLICY 只需要改 USING。

-- [ALL] ai_chat_logs.chat_logs_admin
alter policy chat_logs_admin on gooddays.ai_chat_logs
  using (gooddays_private.is_admin());

-- [ALL] ai_usage.ai_usage_admin
alter policy ai_usage_admin on gooddays.ai_usage
  using (gooddays_private.is_admin());

-- [ALL] bookings.bookings_admin_all
alter policy bookings_admin_all on gooddays.bookings
  using (gooddays_private.is_admin());

-- [SELECT] course_access.course_access_select_own
alter policy course_access_select_own on gooddays.course_access
  using (((auth.uid() = user_id) OR gooddays_private.is_admin()));

-- [ALL] course_details.course_details_admin_write
alter policy course_details_admin_write on gooddays.course_details
  using (gooddays_private.is_admin());

-- [SELECT] course_details.course_details_public_read
alter policy course_details_public_read on gooddays.course_details
  using (((EXISTS ( SELECT 1
   FROM products p
  WHERE ((p.id = course_details.product_id) AND (p.status = 'active'::text)))) OR gooddays_private.is_admin()));

-- [ALL] course_enrollments.course_enrollments_admin_write
alter policy course_enrollments_admin_write on gooddays.course_enrollments
  using (gooddays_private.is_admin());

-- [SELECT] course_enrollments.course_enrollments_select_own
alter policy course_enrollments_select_own on gooddays.course_enrollments
  using (((auth.uid() = user_id) OR gooddays_private.is_admin()));

-- [ALL] course_lessons.course_lessons_admin_all
alter policy course_lessons_admin_all on gooddays.course_lessons
  using (gooddays_private.is_admin());

-- [ALL] membership_tiers.membership_tiers_admin_write
alter policy membership_tiers_admin_write on gooddays.membership_tiers
  using (gooddays_private.is_admin());

-- [ALL] order_items.order_items_admin_write
alter policy order_items_admin_write on gooddays.order_items
  using (gooddays_private.is_admin());

-- [SELECT] order_items.order_items_select_own
alter policy order_items_select_own on gooddays.order_items
  using ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = order_items.order_id) AND ((o.user_id = auth.uid()) OR gooddays_private.is_admin())))));

-- [ALL] orders.orders_admin_write
alter policy orders_admin_write on gooddays.orders
  using (gooddays_private.is_admin());

-- [SELECT] orders.orders_select_own
alter policy orders_select_own on gooddays.orders
  using (((auth.uid() = user_id) OR gooddays_private.is_admin()));

-- [SELECT] points_ledger.points_ledger_select_own
alter policy points_ledger_select_own on gooddays.points_ledger
  using (((auth.uid() = user_id) OR gooddays_private.is_admin()));

-- [ALL] products.products_admin_write
alter policy products_admin_write on gooddays.products
  using (gooddays_private.is_admin());

-- [SELECT] products.products_public_read
alter policy products_public_read on gooddays.products
  using (((status = 'active'::text) OR gooddays_private.is_admin()));

-- [SELECT] profiles.profiles_select_own
alter policy profiles_select_own on gooddays.profiles
  using (((auth.uid() = id) OR gooddays_private.is_admin()));

-- [UPDATE] profiles.profiles_update_own
alter policy profiles_update_own on gooddays.profiles
  using (((auth.uid() = id) OR gooddays_private.is_admin()));

-- [ALL] quotes.quotes_admin_write
alter policy quotes_admin_write on gooddays.quotes
  using (gooddays_private.is_admin());

-- [SELECT] quotes.quotes_select_own
alter policy quotes_select_own on gooddays.quotes
  using (((auth.uid() = user_id) OR gooddays_private.is_admin()));

-- [ALL] settings.settings_admin
alter policy settings_admin on gooddays.settings
  using (gooddays_private.is_admin());

-- [SELECT] webhook_events.webhook_events_admin_read
alter policy webhook_events_admin_read on gooddays.webhook_events
  using (gooddays_private.is_admin());

-- 沒有 CASCADE:只要上面漏改任何一條 policy,這行就會因為相依而失敗,
-- 整個交易 rollback。這是這支 migration 的完整性保險。
drop function gooddays.is_admin();
