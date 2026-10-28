-- 0042_partnership_inquiries.sql
--
-- 異業合作表單（/partnership）的收件匣。
--
-- ── 為什麼有這一支 ───────────────────────────────────────────────────────────
-- 694dedb 上線的 /partnership 只寄信、不落地（當時沒有 DDL 權限）：信寄丟了、被歸到垃圾
-- 信、或 Resend 當下掛掉，這一筆合作邀約就消失了，後台也看不到。從這一支起：
--   · src/server/partnership.ts 在寄信**之前** insert 一列，寄信結果（email_status／
--     email_id／email_error）寫回同一列。insert 失敗仍照樣寄信（不丟 lead），log
--     `[partnership]`。
--   · 後台 /admin/partnerships（只有 admin）看列表、改狀態 new → replied → archived、
--     寫內部備註。
--
-- ── 欄位與 src/lib/partnership.ts 的對應 ────────────────────────────────────
--   type        PARTNERSHIP_TYPES（event／exhibition／consignment／cobrand／private／talk／other）
--   budget      '' ＋ PARTNERSHIP_BUDGETS（undecided／under50k／50k-150k／150k-300k／over300k）
--   長度上限    LIMITS（company 100、name 50、email 254、phone 30、website 300、
--               timeframe 100、message 2000）
--   ⚠️ message 的下限這裡刻意寫 1 而不是 20：zod 量的是 UTF-16 長度、char_length 量的是
--      字元數，十個 emoji 在前台算 20、在這裡算 10。CHECK 比應用層嚴的話，前台放行的
--      那一筆會在 insert 撞牆（雖然信照寄，收件匣卻少一列）。上限方向沒有這個問題
--      （char_length 永遠 ≤ UTF-16 長度）。
--
-- ── 權限 ─────────────────────────────────────────────────────────────────────
-- RLS 開著、零 policy；anon／authenticated 全部收回。只有伺服器端（service_role）讀寫。
-- 前台的 server fn 走 service role insert，所以不需要任何 anon policy。
--
-- ── 種一列 pages ─────────────────────────────────────────────────────────────
-- /partnership 的文案原本全部是程式內建的後備（fetchPage 找不到列就用後備），所以
-- /admin/pages/partnership 沒東西可改。這裡種一列，內容與 src/routes/partnership.tsx 的
-- PAGE 常數逐字相同，所以前台畫面不會變；之後業主在後台改、或加 page_blocks 就生效。
-- on conflict do nothing：已經有人建過就不覆蓋。
--
-- ── 部署順序 ─────────────────────────────────────────────────────────────────
-- 這一支先上正式庫、驗證過，才推讀寫它的程式碼（CLAUDE.md：程式碼不可早於 migration）。

create table if not exists public.partnership_inquiries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  type          text not null,
  company       text not null,
  contact_name  text not null,
  email         text not null,
  phone         text not null default '',
  website       text not null default '',
  timeframe     text not null default '',
  budget        text not null default '',
  message       text not null,
  lang          text not null default 'zh',
  page_url      text not null default '',
  status        text not null default 'new',
  email_status  text not null default 'pending',
  email_id      text,
  email_error   text,
  admin_note    text not null default '',
  constraint partnership_inquiries_type_valid check (
    type in ('event', 'exhibition', 'consignment', 'cobrand', 'private', 'talk', 'other')
  ),
  constraint partnership_inquiries_budget_valid check (
    budget in ('', 'undecided', 'under50k', '50k-150k', '150k-300k', 'over300k')
  ),
  constraint partnership_inquiries_lang_valid check (lang in ('zh', 'en', 'ja')),
  constraint partnership_inquiries_status_valid check (status in ('new', 'replied', 'archived')),
  constraint partnership_inquiries_email_status_valid check (
    email_status in ('pending', 'sent', 'failed')
  ),
  constraint partnership_inquiries_company_len check (char_length(company) between 1 and 100),
  constraint partnership_inquiries_contact_name_len check (
    char_length(contact_name) between 1 and 50
  ),
  constraint partnership_inquiries_email_len check (char_length(email) between 3 and 254),
  constraint partnership_inquiries_phone_len check (char_length(phone) <= 30),
  constraint partnership_inquiries_website_len check (char_length(website) <= 300),
  constraint partnership_inquiries_timeframe_len check (char_length(timeframe) <= 100),
  constraint partnership_inquiries_message_len check (char_length(message) between 1 and 2000),
  constraint partnership_inquiries_page_url_len check (char_length(page_url) <= 300),
  constraint partnership_inquiries_email_error_len check (
    email_error is null or char_length(email_error) <= 500
  ),
  constraint partnership_inquiries_admin_note_len check (char_length(admin_note) <= 2000)
);

create index if not exists partnership_inquiries_created_idx
  on public.partnership_inquiries (created_at desc);

create index if not exists partnership_inquiries_status_idx
  on public.partnership_inquiries (status, created_at desc);

alter table public.partnership_inquiries enable row level security;

revoke all on table public.partnership_inquiries from anon, authenticated;
revoke all on table public.partnership_inquiries from service_role;
grant select, insert, update, delete on table public.partnership_inquiries to service_role;

insert into public.pages (
  slug,
  meta_title,
  meta_description,
  eyebrow_prefix,
  eyebrow_suffix,
  header_title,
  header_intro,
  sort_order
)
values (
  'partnership',
  jsonb_build_object(
    'zh', '異業合作 Partnership｜小時光書店 Interval Books',
    'en', 'Partnership｜Interval Books',
    'ja', '協働・コラボレーションのご相談｜小時光書店 Interval Books'
  ),
  jsonb_build_object(
    'zh', '小時光書店位於華山文創園區，歡迎品牌、企業、創作者與我們合作：活動、展覽、選物寄賣、品牌聯名、企業包場、講座與工作坊。填寫表單，我們會在 3 個工作天內回覆。',
    'en', 'Interval Books at Huashan welcomes brands, companies and creators: events, exhibitions, consignment, brand collaborations, private bookings, talks and workshops. Send us a note — we reply within 3 business days.',
    'ja', '華山の小時光書店では、ブランド・企業・作り手との協働を歓迎しています。イベント、展示、委託販売、ブランドコラボ、貸切、講座・ワークショップ。フォームからご相談ください。3営業日以内にお返事します。'
  ),
  'Partnership',
  jsonb_build_object('zh', '異業合作', 'en', '異業合作', 'ja', '異業合作'),
  jsonb_build_object(
    'zh', '在華山，一起做點什麼',
    'en', 'Let''s make something together, at Huashan',
    'ja', '華山で、いっしょに何かを'
  ),
  jsonb_build_object(
    'zh', '一間書店能承接的，比書更多。如果你有一個想法——一場活動、一檔展覽、一個聯名的念頭——歡迎來聊聊。',
    'en', 'A bookshop can hold more than books. If you have an idea — an event, an exhibition, a collaboration — we''d love to hear it.',
    'ja', '本屋が受けとめられるのは、本だけではありません。イベント、展示、コラボレーション。思いついたことがあれば、ぜひお聞かせください。'
  ),
  12
)
on conflict (slug) do nothing;
