# 三站資料庫整合 — 腳本與 Phase 0 結果

計畫全文：`~/.claude/plans/noble-roaming-avalanche.md`（2026-09-14 核准）。這個目錄是 Phase 1 的腳本；**全部只對「目標專案」跑，三個舊專案在觀察期結束前一律不動。**

## 執行順序（目標專案上）
| 順序 | 檔案 | 做什麼 | 狀態 |
|---|---|---|---|
| 00 | `00_intervalbooks_baseline.sql` | 小時光 live `pg_dump --schema-only`（public+inv+auth trigger 除外） | ⏳ 等連線字串 |
| 10 | `10_happyhands.sql` | 快樂手 21 支 → `happyhands` schema（515 處改寫、殘留 0、未限定 0） | ✅ 產生器輸出 |
| 20 | `20_gooddays.sql` | 好日子 16 支 → `gooddays` + `gooddays_private`（275 處、殘留 0） | ✅ |
| 30 | `30_gooddays_grants.sql` | 好日子原本沒寫的 grant（照 public 預設補） | ✅ |
| 40 | `40_auth_triggers.sql` | 三個獨立的 auth trigger（扇出＋吃例外） | ✅ |
| 50 | `50_load_data.sh` | 三站 `pg_dump --data-only` → 目標；auth.users/identities 明列欄位、remap 重複 2 人 | ⏳ 等連線字串 |
| 60 | `60_url_rewrite.sql` | 14 列舊 ref URL 改寫（四張表欄位已確認：cover_url text、其餘 jsonb） | ✅ |
| 70 | `70_verify.sql` | 十段驗證，任一不符就停 | ✅ |
| 80 | `80_reverse_delta.sh` | 快樂手回退用的反向增量 | 🟡 骨架，排練時實跑 |

產生器：`rewrite_schema.py`（改規則改它，不要手改 10/20 的輸出）。

## Phase 0 探勘結果（2026-09-15）
- UUID 三組交集 **0**（全保留可行）；email 重複 3 個全是員工。
- 小時光 live vs repo 38 支：表／函式／欄位／view **零差異**；18 條 policy 是 parser 漏抓（名稱帶引號），repo 都有 → **live pg_dump 當 baseline 可靠**。
- 小時光 DDL 經 Management API **可以**（memory 舊記錄已過時）；cron 3 個、vault 3 個（`tasks_secret`、`tasks_endpoint_url`、`notify_tasks_endpoint_url`）要在目標重建。
- 好日子 5 支未記錄的 migration **其實全套用了**（`deduct_product_stock()` 本體已是 FOR UPDATE 新版），只要補帳。
- 活著的金流：小時光黑貓（5）＋轉帳（1）、快樂手黑貓（7）、好日子 PayUni（程式碼；DB 只剩 7/19 一筆 pchomepay 舊單）。
- 快樂手 `handle_new_user` 在 migration 裡 replace 過兩次，`40` 取最終版。

## 來源列數（載入後 70 第 9 段要對的數字）
auth.users 46（8+39+2−3 重複）；public.orders 10；inv.purchases 1,029；happyhands.orders 38／profiles 39；gooddays.orders 2／profiles 2。

## 排練紀錄
- **2026-09-15 第一次（schema 部分）**：丟棄式專案 `consolidation-rehearsal`。10（21 段）／20（16 段）／30／40 全過；70 的 schema 段：表數、函式數、policy 數、search_path 0、殘留 0、三個 trigger、grant 全對。
- 教訓：20 第 16 段 `alter policy … using (…)` 裡有原檔就沒寫前綴的表名，Management API 的 session search_path 是 public 就找不到 → 產生器改成**每段自帶 `set search_path = <schema>, public;`**；`run_sql.py` 另有 `--search-path` 當保險、`--from N` 重跑失敗段。
- **2026-09-15 第二次（schema 部分）**：drop 重來，runner **不帶** `--search-path`，10／20／30／40 全過、六項驗證全綠 → SQL 檔已自包含。
- 教訓 2：`set search_path = <schema>, public` 會把 Supabase 預設裡的 `extensions` 擠掉（pgcrypto 的 `gen_random_bytes` 住那裡），一律寫 `<schema>, public, extensions`。
- 待做：00 baseline 與 50 資料（等三站 DB 資料）；60／80 在有資料後排練。

## TODO
- 三站 Session pooler 連線字串到位後：跑 00 → 50 → 60 → 70 全段，然後刪掉 rehearsal 重來一次乾淨的。
