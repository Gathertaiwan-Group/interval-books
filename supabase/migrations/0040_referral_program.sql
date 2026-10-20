-- =============================================================================
-- 0040 推薦碼與分潤（推廣者／歸屬／月結）
-- =============================================================================
--
-- 設計全文在 docs/referral-program.md。這裡只記 SQL 層面的決定。
--
-- §0 只新增，不改既有的任何東西
--   · 三張新表：referrers（推廣者）、referral_settings（單列全站預設）、
--     referral_settlements（某位推廣者某個月已結算的紀錄）。
--   · orders 加三個 nullable 欄位：referrer_id / referral_code /
--     referral_discount_percent。折扣金額本身寫進 0005 就有的 orders.discount
--     （那一欄一直是 0，等的就是這一天），所以金流（黑貓／PayUni／匯款）拿的
--     orders.total 與發票的負數折扣列（invoice-issuer.ts）都不必改。
--   · 舊訂單三欄全是 NULL ＝ 沒有推薦人，語意正確，不需回填。
--
-- §1 授權：與 0005 的商務表同一套
--   RLS 開著、零 policy、revoke anon/authenticated、只 grant service_role。
--   瀏覽器碰不到任何一張；前台「這個碼有效嗎」由 server fn 用 service_role 查，
--   只回折扣百分比，不回推廣者的姓名與聯絡方式。
--
-- §2 為什麼結算是一張表而不是 orders 上的旗標
--   「這個月已經付過了」是推廣者 × 月份的事實，不是單一訂單的事實；
--   unique(referrer_id, period) 讓同一個月不可能被結算兩次（重複按、兩個分頁同時
--   按都一樣會撞 23505）。snapshot 存當下逐筆的分潤金額，之後的退款扣回
--   （clawback）就是拿它來對。
--
-- §3 訂單上的 referrer_id 是 on delete restrict
--   有訂單掛著的推廣者不可以被刪（只能停用）——刪了就對不出那幾張單是誰帶來的。
--   後台只提供「停用」。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. referrers —— 推廣者
-- ---------------------------------------------------------------------------
create table if not exists public.referrers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(btrim(name)) between 1 and 60),
  -- 大寫英數 2–20 碼。前台輸入一律先轉大寫再比對（src/lib/referral.ts normalizeReferralCode）。
  code               text not null unique check (code ~ '^[A-Z0-9]{2,20}$'),
  -- team＝團隊成員（工讀生／員工，可分團隊獎金池）；external＝外部推廣者（只有分潤）。
  kind               text not null default 'external' check (kind in ('team', 'external')),
  contact            text check (contact is null or char_length(contact) <= 200),
  -- 自購排除用：訂單的 email／手機與這兩欄相同 → 不計分潤。
  email              text check (email is null or char_length(email) <= 120),
  phone              text check (phone is null or char_length(phone) <= 30),
  -- 底薪，只是記錄，不參與任何計算。
  base_salary        integer check (base_salary is null or base_salary >= 0),
  -- 客人用這個碼的折扣 %。NULL ＝ 用 referral_settings 的預設。
  discount_percent   numeric(5,2) check (discount_percent is null or (discount_percent >= 0 and discount_percent <= 50)),
  -- 個人的分潤級距（覆寫全站預設）。NULL ＝ 用 referral_settings.commission_tiers。
  commission_tiers   jsonb check (commission_tiers is null or jsonb_typeof(commission_tiers) = 'array'),
  active             boolean not null default true,
  note               text check (note is null or char_length(note) <= 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. referral_settings —— 單列全站預設
-- ---------------------------------------------------------------------------
create table if not exists public.referral_settings (
  id                         integer primary key default 1 check (id = 1),
  default_discount_percent   numeric(5,2) not null default 5 check (default_discount_percent >= 0 and default_discount_percent <= 50),
  -- 沒有可信進價時估算用的毛利率。
  default_margin_percent     numeric(5,2) not null default 35 check (default_margin_percent >= 0 and default_margin_percent <= 100),
  -- 累進級距（像所得稅，不是跳級）：[{ "upTo": 10000, "rate": 15 }, …, { "upTo": null, "rate": 25 }]
  commission_tiers           jsonb not null default '[{"upTo":10000,"rate":15},{"upTo":30000,"rate":20},{"upTo":null,"rate":25}]'::jsonb
                             check (jsonb_typeof(commission_tiers) = 'array'),
  new_customer_multiplier    numeric(4,2) not null default 1.25 check (new_customer_multiplier >= 1 and new_customer_multiplier <= 3),
  -- 團隊獎金池：當月線上選品營收超過門檻的部分 × pool_percent。門檻 NULL ＝ 不計算。
  team_pool_baseline         integer check (team_pool_baseline is null or team_pool_baseline >= 0),
  team_pool_percent          numeric(5,2) not null default 5 check (team_pool_percent >= 0 and team_pool_percent <= 50),
  -- 獎金池的平分比例（其餘按團隊成員各自的歸屬毛利占比分）。
  team_pool_equal_percent    numeric(5,2) not null default 50 check (team_pool_equal_percent >= 0 and team_pool_equal_percent <= 100),
  -- 安全上限：當月分潤＋獎金池 ≤ 當月選品毛利 × cap%。
  payout_cap_percent         numeric(5,2) not null default 40 check (payout_cap_percent >= 0 and payout_cap_percent <= 100),
  -- 已結算月份結束後幾天內的取消／退款，要從下一次結算扣回。
  clawback_days              integer not null default 30 check (clawback_days between 0 and 365),
  updated_at                 timestamptz not null default now()
);

insert into public.referral_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. referral_settlements —— 月結紀錄
-- ---------------------------------------------------------------------------
create table if not exists public.referral_settlements (
  id               uuid primary key default gen_random_uuid(),
  referrer_id      uuid not null references public.referrers (id) on delete restrict,
  period           text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- 實付金額（分潤＋獎金池−扣回）。扣回比當月多時可以是負數＝推廣者應退。
  amount           integer not null,
  commission       integer not null default 0,
  pool_share       integer not null default 0,
  clawback         integer not null default 0,
  -- 逐筆分潤、扣回的訂單 id、上限比例等，見 src/lib/referral.ts SettlementSnapshot。
  snapshot         jsonb not null default '{}'::jsonb,
  settled_by       uuid,
  settled_by_email text,
  settled_at       timestamptz not null default now(),
  note             text check (note is null or char_length(note) <= 500),
  unique (referrer_id, period)
);

-- ---------------------------------------------------------------------------
-- 4. orders 上的歸屬欄位
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists referrer_id uuid references public.referrers (id) on delete restrict,
  add column if not exists referral_code text,
  add column if not exists referral_discount_percent numeric(5,2);

create index if not exists orders_referrer_idx
  on public.orders (referrer_id, paid_at) where referrer_id is not null;

-- ---------------------------------------------------------------------------
-- 5. 授權（見 §1）
-- ---------------------------------------------------------------------------
alter table public.referrers enable row level security;
alter table public.referral_settings enable row level security;
alter table public.referral_settlements enable row level security;

revoke all on table public.referrers from anon, authenticated;
revoke all on table public.referral_settings from anon, authenticated;
revoke all on table public.referral_settlements from anon, authenticated;

grant all on table public.referrers to service_role;
grant all on table public.referral_settings to service_role;
grant all on table public.referral_settlements to service_role;
