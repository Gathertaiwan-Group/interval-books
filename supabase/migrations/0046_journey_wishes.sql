-- 0046_journey_wishes.sql
--
-- 策旅著陸頁「下次，我想這樣玩」願望表單的收件匣（通用：一張表給所有策旅頁共用）。
--
-- ── 為什麼有這一支 ───────────────────────────────────────────────────────────
-- 220baaa 上線的 /events/kungtung 願望表單按送出只會開 mailto:，訪客沒有設定郵件程式就
-- 什麼都沒發生、店家也收不到。業主確認後改成：
--   · src/server/journey-wish.ts 先 insert 一列，再寄通知信給 site_settings.notify_emails，
--     寄信結果（email_status／email_id／email_error）寫回同一列（做法照 0042 的異業合作）。
--   · 後台 /admin/journey-wishes（只有 admin）看列表、改狀態 new → reviewed → archived、
--     寫內部備註。
--
-- ── 通用的那一半 ─────────────────────────────────────────────────────────────
--   source      哪一頁送來的（'kungtung'…）。CHECK 只限格式（小寫英數與 -），不列舉：
--               之後新的策旅頁要共用，只要在 src/lib/journey-wish.ts 的 WISH_SOURCES
--               加一個 key，不必再跑 migration。應用層只收白名單裡的值。
--   interests   勾選的「最想體驗」（每頁自己的選項；應用層驗證是那一頁白名單裡的字）。
--   至少要有一項 interests 或一段 wish（與前台「請至少選一項，或寫下你的旅行願望」一致）。
--
-- ── 欄位與 src/lib/journey-wish.ts 的對應 ───────────────────────────────────
--   長度上限  WISH_LIMITS（wish 1000、name 100、email 254、interests 最多 20 項）
--   ⚠️ char_length 量字元數、zod 量 UTF-16 長度；上限方向 char_length 永遠 ≤ UTF-16 長度，
--      所以 CHECK 不會比應用層嚴。
--
-- ── 權限 ─────────────────────────────────────────────────────────────────────
-- RLS 開著、零 policy；anon／authenticated 全部收回。只有伺服器端（service_role）讀寫。
-- 主鍵是 uuid（gen_random_uuid），沒有 identity／serial，所以沒有 sequence 要收回權限。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 這一支先上正式庫、驗證過，才推讀寫它的程式碼。

create table if not exists public.journey_wishes (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  source         text not null,
  interests      text[] not null default '{}',
  wish           text not null default '',
  name           text not null default '',
  email          text not null default '',
  join_friends   boolean not null default false,
  notify_opt_in  boolean not null default false,
  lang           text not null default 'zh',
  page_url       text not null default '',
  status         text not null default 'new',
  email_status   text not null default 'pending',
  email_id       text,
  email_error    text,
  admin_note     text not null default '',
  constraint journey_wishes_source_format check (source ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  constraint journey_wishes_interests_count check (cardinality(interests) <= 20),
  constraint journey_wishes_not_empty check (
    cardinality(interests) > 0 or char_length(wish) > 0
  ),
  constraint journey_wishes_wish_len check (char_length(wish) <= 1000),
  constraint journey_wishes_name_len check (char_length(name) <= 100),
  constraint journey_wishes_email_len check (char_length(email) <= 254),
  constraint journey_wishes_lang_valid check (lang in ('zh', 'en', 'ja')),
  constraint journey_wishes_page_url_len check (char_length(page_url) <= 300),
  constraint journey_wishes_status_valid check (status in ('new', 'reviewed', 'archived')),
  constraint journey_wishes_email_status_valid check (
    email_status in ('pending', 'sent', 'failed')
  ),
  constraint journey_wishes_email_error_len check (
    email_error is null or char_length(email_error) <= 500
  ),
  constraint journey_wishes_admin_note_len check (char_length(admin_note) <= 2000)
);

create index if not exists journey_wishes_created_idx
  on public.journey_wishes (created_at desc);

create index if not exists journey_wishes_status_idx
  on public.journey_wishes (status, created_at desc);

create index if not exists journey_wishes_source_idx
  on public.journey_wishes (source, created_at desc);

alter table public.journey_wishes enable row level security;

revoke all on table public.journey_wishes from anon, authenticated;
revoke all on table public.journey_wishes from service_role;
grant select, insert, update, delete on table public.journey_wishes to service_role;
