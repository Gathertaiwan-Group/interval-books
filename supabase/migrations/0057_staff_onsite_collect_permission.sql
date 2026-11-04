-- 0057_staff_onsite_collect_permission.sql —— 第十種 staff 權限：event.onsite.collect（業主 2026-11-04）
--
-- 業主：活動當天在現場的門市人員（staff）也要能按「標記已收款」，但**只限現場付款**
-- （payment_method = 'onsite'，0056）的訂單。匯款、舊的「由店家聯繫付款」等其他付款方式
-- 照舊只有 admin 能標記。
--
-- ── 為什麼是新權限，不是沿用 event.roster.read ─────────────────────────────
-- event.roster.read 是「能不能看名單（客人個資）」；這一個是「能不能宣稱收到一筆錢」——
-- 會讓訂單變成已付款、寄出付款成功信、開立發票。兩件事給的人不一定一樣（只負責簽到的
-- 工讀生不該能收錢），所以分開。admin 自動擁有（requireStaff() 對 admin 不查表）。
--
-- ── 檢查在哪裡 ──────────────────────────────────────────────────────────────
-- 收款本身仍呼叫 admin_mark_order_paid()（0034 §5，一個字沒動）：那支函式在資料庫裡**沒有**
-- 限定 admin（它只 grant service_role，誰能呼叫由應用層決定），所以不需要另做一支 SQL 版本。
-- 「只限 onsite」與「需要 event.onsite.collect」兩道檢查在 server fn
-- markOnsiteOrderPaidStaff（src/lib/admin/fns/orders.ts）。
--
-- 做法同 0019 §3.7／0021 §4：值域取自 0021（九種）再加一個，drop if exists + add（冪等）。
begin;

alter table public.staff_permissions drop constraint if exists staff_permissions_permission_check;

alter table public.staff_permissions
  add constraint staff_permissions_permission_check
  check (permission in (
    'approve_products',
    'approve_purchases',
    'approve_price_changes',
    'approve_vendors',
    'approve_combo_sets',
    'approve_stock_adjustments',
    'approve_inventory_adjustments',
    'inv.vendor.pii.read',
    'event.roster.read',
    'event.onsite.collect'
  ));

comment on column public.staff_permissions.permission is
  '七種 approve_*（能不能簽核）＋ inv.vendor.pii.read（能不能看廠商的完整身分證／統編／銀行帳號）＋ event.roster.read（能不能看活動報名名單）＋ event.onsite.collect（能不能把現場付款的訂單標記已收款，0057）。';

commit;
