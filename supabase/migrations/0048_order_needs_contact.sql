-- 0048_order_needs_contact.sql —— 匯款訂單的「需專人聯繫」旗標（業主 2026-10-29，方案 A）
--
-- ── 在補哪個洞 ──────────────────────────────────────────────────────────────
-- 結帳頁原本有三個付款選項：信用卡、銀行匯款、「由我們與你聯繫付款」（payment_method
-- = NULL）。業主決定把後兩者合併：結帳頁只剩「信用卡」與「銀行匯款」，選匯款時多一個
-- 「我需要專人聯繫協助付款」勾選框。勾了的訂單仍然是 payment_method = 'transfer'
-- （帳號、匯款資訊信、3 天保留、末五碼回報全部照 0034），只是店家要知道「這位客人要
-- 我們主動聯繫」。
--
-- ── 為什麼要 DDL ────────────────────────────────────────────────────────────
-- orders 沒有 jsonb metadata 欄位；唯一的自由文字欄 note 是客人自己在結帳頁打的備註，
-- 把系統旗標塞進去會讓客人打得出同一段字、也會在後台與信裡被當成客人的話印出來。
-- 所以加一個 boolean。
--
-- ── 為什麼 not null default false ──────────────────────────────────────────
-- · 舊程式（部署前）insert 時不帶這一欄 → 拿到 false，行為與今天逐字相同。
-- · PG 11+ 對帶常數 default 的 add column 只改 catalog，不重寫表、不長時間鎖表。
-- · 既有訂單一律是 false：舊的 NULL 單照原本「由店家聯繫付款」流程處理（後台已經依
--   payment_method IS NULL 顯示），不需要這個旗標重複表達。
--
-- 權限：orders 只 grant 給 service_role（anon／authenticated 沒有任何表或欄位權限），
-- 新欄位沿用表層級權限，不另外 grant。expire_unpaid_orders() 不動。

begin;

alter table public.orders
  add column if not exists needs_contact boolean not null default false;

comment on column public.orders.needs_contact is
  '0048：客人在結帳頁選銀行匯款時勾了「我需要專人聯繫協助付款」。只對 payment_method = ''transfer'' 有意義；舊的 NULL（由店家聯繫付款）訂單不用這一欄。';

commit;
