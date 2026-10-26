-- =============================================================================
-- 0041 主理人的選品 → 連到真正的商品
-- =============================================================================
--
-- 業主（2026-10-26）：首頁「主理人的選品」那一排要放的是**主理人挑的**那幾件，
-- 不是「後台排序最前面的四件」。在這之前 curated_items 只有 name／note，沒有任何
-- 一欄指到 products，所以選品在前台永遠「只展示、不販售」。
--
-- §0 只新增，不改既有的任何東西
--   · curated_items 加一個 nullable 欄位 product_id。NULL ＝ 沒連結＝照舊只展示，
--     既有的 18 件全部是 NULL，語意不變，不需要回填。
--   · 型別是 text，不是 uuid：products.id 是 `text primary key`（0004）。
--     publications.product_id（0015）也是 text，同一個理由。
--
-- §1 外鍵 on delete set null
--   商品被刪掉時，選品本身要留著（主理人寫的名稱與備註不該跟著消失），只是退回
--   「只展示」。商品下架（status 改 archived）不會觸發這條——那由前台的讀取規則處理：
--   anon 的 RLS 本來就只看得到 status='active' 的商品（0004 products_select_public），
--   所以連到下架商品的選品，前台自動當成沒連結。
--
-- §2 刻意**不**加 unique
--   publications.product_id 有 unique（一本刊物一件商品，否則庫存在兩處各賣一次）。
--   選品不一樣：同一件商品出現在兩個主題櫥窗是合理的（「秋日的桌面」與「送禮」都放
--   同一只杯），它賣的仍然是同一件商品、同一份庫存，不會重複扣。首頁那一排自己去重。
--
-- §3 活動／策旅票券不能被連
--   這一條放在程式裡（後台選擇器只列 goods/book，首頁與 /shop 只認 goods/book），
--   不寫成 CHECK：跨表的條件 CHECK 做不到，trigger 又要多一支函式與它的授權。
--   萬一真的被連到票券，前台一律當成沒連結（不會出現沒選場次的加入購物車）。
--
-- §4 授權不變
--   curated_items 的 grant／RLS 是 0001 的那一套：anon/authenticated 只能 select
--   已發布的列，寫入全擋，service_role 全權。新欄位跟著同一張表的 grant 走，不需要
--   另外 grant——商品 id 本來就是公開的（/shop 的每一張卡都帶著它）。
--
-- §5 冪等
--   add column if not exists ＋ create index if not exists；外鍵條件約束跟著欄位
--   一起建，欄位已存在時整句跳過，不會建出第二個外鍵。重跑安全。
-- =============================================================================

alter table public.curated_items
  add column if not exists product_id text
    references public.products (id) on delete set null;

-- 首頁與 /shop 只讀「有連結的那幾列」；後台刪商品時 on delete set null 也要靠它找列。
create index if not exists curated_items_product_idx
  on public.curated_items (product_id)
  where product_id is not null;
