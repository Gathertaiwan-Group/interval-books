# 三站資料庫整合 — 腳本與排練紀錄

計畫全文：`~/.claude/plans/noble-roaming-avalanche.md`（2026-09-14 核准）。這個目錄是 Phase 1 的腳本；**全部只對「目標專案」跑，三個舊專案在觀察期結束前一律不動。**

## 執行順序（目標專案上）

| 順序 | 檔案 | 做什麼 |
|---|---|---|
| — | `check_dumps.sh` | 驗七個 dump 檔存在、格式對、關鍵數字對 |
| 00 | `00_load_baseline.sh` | 啟 pg_cron/pg_net → 載入小時光 schema（`dump_ib_schema.sql`） |
| 10 | `10_happyhands.sql` | 快樂手 21 支 migration → `happyhands` schema（515 處改寫、殘留 0、未限定 0） |
| 20 | `20_gooddays.sql` | 好日子 16 支 → `gooddays` ＋ `gooddays_private`（276 處、殘留 0） |
| 30 | `30_gooddays_grants.sql` | 好日子的 grant。**由 `gen_grants.py` 從好日子 live 庫的實際 ACL 產生**（好日子上線前若動了 schema 要重新產生） |
| 40 | `40_auth_triggers.sql` | 三個獨立的 auth trigger（扇出＋吃例外） |
| 50 | `50_load_data.sh` | 七個 dump：remap → auth（濾重複）→ 業務表（replica）→ profiles 回填 |
| 60 | `60_url_rewrite.sql` | 14 列舊 ref URL 改寫（replica 模式，不動 updated_at） |
| 70 | `70_verify.sql` | 十段 catalog 驗證，任一不符就停 |
| 71 | `71_behaviour_checks.sql` | 七段**行為**驗證：真的冒充帳號呼叫 `is_admin()`、真的在 PostgREST 的 search_path 下讀裸表名、真的建一個帳號看三個 trigger 扇出（最後 rollback） |
| 74 | `74_postgrest_checks.sh` | **從外面**用 HTTP 驗：同一個 `/products` 端點靠 `Accept-Profile` 分流到三個 schema、`gooddays_private` 不可曝露、anon 讀不到點數 view |
| 80 | `80_reverse_delta.sh` | 快樂手回退用的反向增量（新增＋狀態更新＋序列同步） |
| 90 | `90_storage_migrate.py` | Storage 桶子與物件（三站 8 桶 205 物件約 19MB），逐物件 md5 驗證 |
| 91 | `91_cron_vault.py` | 小時光的 3 個 pg_cron 排程與 3 個 vault secret；**排程預設 active=false**，切換那一刻才 `--activate` |
| 92 | `92_auth_settings.py` | Auth 集團級設定：redirect 白名單聯集、信箱驗證開啟、密碼長度取最嚴、寄件人「好日子 Good Days」 |
| 93 | `93_api_settings.py` | PostgREST 曝露 `happyhands`／`gooddays`（不做這步，client 設了 `db.schema` 也會 404 PGRST106） |

一鍵跑完（只對丟棄式／全新專案）：`./run_rehearsal.sh <ref>`（含 reset）。

## 工具

| 檔案 | 用途 |
|---|---|
| `mgmt.py` | Management API 查詢 helper（curl，非 requests——Cloudflare 1010）。**token 按專案 ref 解析**：來源三站與目標可能在不同的 Supabase 帳號下，對照表放 `scratchpad/supabase_tokens.tsv`（`<ref 或 *>` → token 檔名） |
| `api_ddl.py` | 從 catalog 產 schema-only DDL（＝ `pg_dump --schema-only --no-owner`，但不需要 DB 密碼） |
| `api_dump.py` | 從 catalog 產 data-only dump（COPY 段＋setval，格式與 `pg_dump --data-only` 相同） |
| `schema_diff.sh` | 兩個專案各跑一次 `api_ddl.py` 再 diff——schema 忠實度的證據（`IGNORE_RE` 略過刻意多出來的物件，略過的是整個區塊不是單行） |
| `data_diff.py` | 來源 vs 目標逐表 `count(*)` 與整表 md5（支援 UUID remap、URL 改寫、profiles/auth 篩選） |
| `72_grant_parity.py` | 來源 vs 目標的**有效權限**逐物件×角色比對（`has_*_privilege`，含 PUBLIC 與繼承） |
| `gen_grants.py` | 30 的產生器：從來源 ACL 產出逐物件的 revoke／grant |
| `run_sql.py` | 對某專案逐段跑 SQL 檔（`-- ===== 段名 =====` 分段，一段一交易） |
| `rewrite_schema.py` | 10／20 的產生器。**改規則改它，不要手改輸出** |
| `run_rehearsal.sh` / `81_reverse_delta_drill.sh` | 全流程排練 / 反向 delta 演練 |

### 為什麼不用 pg_dump

原本要使用者自己跑 `pg_dump`（密碼不經過我）。後來改成 `api_ddl.py` / `api_dump.py` 走 Management API：不需要 DB 密碼、不必等人，而且忠實度是**可證明**的——`schema_diff.sh` 從來源與目標兩邊各產一次 DDL 再 diff，`data_diff.py` 逐表比 md5。真要用 pg_dump 也相容：輸出格式一樣，`check_dumps.sh` 兩者都吃。

## 現況：Phase 1 完成（2026-09-15）

丟棄式專案 `consolidation-rehearsal`（`czkihcevxvyzrgbetrua`）上，從 reset 開始跑完整套兩次，全部通過：

**schema**
- `schema_diff.sh` 對小時光：**11,185 行 DDL 逐字一致**（目標只多出 40 刻意建的 `interval_on_auth_user_created()`）（表 60／序列 16／函式 133／約束 309／索引 171／view 31／trigger 58／policy 74／欄位 default 284／欄位級 ACL 22）。
- 70 的十段：表數 39/21/20/16、函式 99/35/29/9/1、policy 74/21/25、search_path 稽核 0、殘留 `public.` 0、view 跨 schema 依賴 0、三個 auth trigger、grant 齊。

**資料**（`data_diff.py`，121 項逐表 md5）
- 小時光 → `public`＋`inv`：60 表＋16 序列＋auth 全部相同。
- 快樂手 → `happyhands`：20 表全部相同（UUID remap 與 URL 改寫後）。
- 好日子 → `gooddays`：16 表全部相同（`_migrations` 依設計不搬）。
- `auth.users` 46（8＋39＋2−3 重複）；三個 schema 的 `profiles` 各 46 列（每個帳號在每站都有一列）。

**Storage／cron／vault／Auth／PostgREST**（全部在排練專案實跑過）
- 205 個物件全搬完（139＋9＋57），逐一下載→上傳→抓回來比 md5，桶子設定一致，總數與位元組數相符。
- 3 個 vault secret 寫入後兩邊 md5 相同；3 個排程建成 `active=false`，重跑冪等。
- Auth：白名單 9 條、`site_url`、密碼長度 8 已套用；寄件人與額度等自訂 SMTP。
- PostgREST：`74_postgrest_checks.sh` 四項全過。

**權限**（`72_grant_parity.py`，252 組物件×角色）
- 快樂手 → `happyhands` 153 組、好日子 → `gooddays` 93 組、`private` → `gooddays_private` 6 組，**有效權限完全一致**。

**行為**（`71_behaviour_checks.sql`，七段全綠）
- 冒充「小時光 admin 但好日子不是 admin」的帳號呼叫 `gooddays_private.is_admin()` → false；冒充好日子自己的 admin → true。好日子 25 條 policy 有 23 條指向 `gooddays_private.is_admin()`，0 條指向 public。
- 在 `search_path = happyhands, public, extensions`（＝PostgREST 的行為）下讀裸表名 `products`：看到 8 列（happyhands 自己的），不是小時光的 22 列；gooddays 看到 20 列。
- 真的 insert 一個 `auth.users`：三個 schema 各長出一列 profile、快樂手的 `full_name` 有吃到 metadata（驗完 rollback）。
- 故意讓快樂手的 trigger 失敗（加一條 `check (false) not valid`）：帳號照樣建得起來，小時光與好日子的 profile 照樣長出來，只留下一行 warning——`exception when others` 的設計有效。

**反向 delta**（`81_reverse_delta_drill.sh`）
- 造 3 筆窗口內新訂單＋明細＋付款事件＋2 封信，另有 2 筆「切換前存在、窗口內被 webhook 改成 paid」的訂單。
- 跑第一次：全部倒回舊庫、付款狀態跟上、序列對齊、無孤兒；跑第二次：新增全略過、更新寫回同值（冪等）。
- 八張表列數相同、`orders`／`order_items` 整表 md5 相同。演練列自清，真實資料事後再比對仍全部相同。

## 排練中抓到、已修的坑

| # | 症狀 | 真因與修法 |
|---|---|---|
| 1 | `alter policy` 找不到表 | 原檔沒寫 schema 前綴，建立時才解析 → 產生器改成**每段自帶** `set search_path = <schema>, public, extensions` |
| 2 | `gen_random_bytes` 不存在 | `set search_path = <schema>, public` 把預設的 `extensions` 擠掉 → 一律補 `, extensions` |
| 3 | 快樂手資料**靜默灌進小時光的 public 表** | macOS 的 BSD sed 不支援 `\b`，`s/\bpublic\./happyhands./` 什麼都沒換 → 改用 python 只改 COPY 標頭與 setval 行 |
| 4 | 小時光 8 筆員工 profile 沒載入 | `strip_copy`／`fill_profiles` 用「結尾是 `.profiles`」比對，先撞到 `inv.profiles` → 改成完整 `schema.table` 精確比對，找不到就中止 |
| 5 | `20` 建出來的是 `private` 而不是 `gooddays_private` | 改寫規則只認 `schema private`，漏了 `schema if not exists private` |
| 6 | 14 列 URL 改寫後 md5 對不上 | `set_updated_at` trigger 把 `updated_at` 蓋成搬遷當下 → 60 改在 `session_replication_role = replica` 下跑 |
| 7 | 70 第 5 段 `"array_agg" is an aggregate function` | `pg_get_functiondef` 吃到 aggregate → 加 `case when prokind in ('f','p')` |
| 8 | 80 `on conflict (id)` 會炸 | `entitlements` 主鍵是 `(user_id, product_id)` 根本沒有 id；`orders.order_no`／`email_outbox.dedupe_key`／`payment_events` 的唯一索引撞上時，指定仲裁鍵會丟例外 → 改用**不指定目標**的 `on conflict do nothing`，並印出略過列數 |
| 9 | 80 只搬新增會**掉掉付款** | 窗口內 webhook 把切換前的訂單翻成 paid → 加階段 B：`updated_at > CUTOVER` 的列以主鍵 upsert 整列 |
| 10 | `cannot insert a non-DEFAULT value into column "id"` | `audit_log.id` 是 `GENERATED ALWAYS AS IDENTITY` → `insert … select` 要加 `overriding system value`（COPY 不用） |
| 11 | 舊庫回退後下一筆 insert 會撞主鍵 | 明寫 id 不推進序列 → 80 加階段 C：把舊庫每個 serial／identity 序列 setval 到 max+1 |
| 12a | 🔴 **好日子的 grant 被我開太大** | 原本 30 是一句 `grant all on all tables/functions`。72 抓到來源其實關著 6 個物件：`v_user_points_balance`／`v_expirable_earn_points` 兩個 `security_invoker=false`（繞過底下表 RLS）的點數 view，以及 `reserve_course_seat`／`release_course_seats_for_order`／`expire_course_reservations`／`handle_new_user` 四支 security definer——全開等於把**全體會員的點數餘額與座位操作對 anon 打開**。改成由 `gen_grants.py` 照來源 ACL 逐物件產生 |
| 12 | `CREATE SEQUENCE … AS smallint` 在 identity 上報 redundant | identity 的序列型別跟著欄位走 → `api_ddl.py` 對 identity 不輸出 `AS <type>` |

## 來源列數（70 第 9 段要對的數字）

auth.users 46；public.orders 10；inv.purchases 1,029；happyhands.orders 38／profiles 39；gooddays.orders 2／profiles 2。

## Phase 2 的周邊（腳本已寫好並在排練專案實跑過）

- **Storage**（`90_storage_migrate.py`）：三站 8 個桶、205 個物件、約 19MB，桶名沒有衝突。走 Storage API
  （`storage.buckets`／`storage.objects` 有平台保護，SQL 直接寫會被擋），service_role key 即時從
  Management API 取、不落地。逐物件下載→上傳→再抓回來比 md5。
- **cron／vault**（`91_cron_vault.py`）：3 個排程與 3 個 secret。secret 的值不經過對話、只比對兩邊各自算的 md5。
  🔴 排程**建成 active=false**，切換那一刻才 `--activate`——早開會讓新舊兩邊各跑一次 `dispatch_invoice_task`，
  同一張單開兩張發票。（`update cron.job` 會 permission denied，開關一律走 `cron.alter_job()`。）
- **PostgREST**（`93_api_settings.py`）：`db_schema` 補上 happyhands／gooddays；
  🔴 `db_extra_search_path` 維持 `public, extensions` **不要動**——把新 schema 加進去等於讓三個 schema 的
  裸表名互相污染（計畫裡「最陰的失敗模式」）。`gooddays_private` 不曝露。
  設定完用 `74_postgrest_checks.sh` 從 HTTP 驗一次：同一個 `/products` 端點三個 profile 各回自己的數字
  （22／6／20，快樂手的 6 是 RLS 擋掉未上架的，不是錯），`gooddays_private` 回 PGRST106，
  anon 讀點數 view 回 42501。
- **Auth**（`92_auth_settings.py`）：白名單聯集 9 條、`site_url`、密碼長度 8。
  🔴 **好日子現在 `mailer_autoconfirm = true`（信箱驗證是關的）**，合併後必須開——小時光與快樂手的
  `claim_guest_orders()` 都以 `email_confirmed_at is not null` 當第一道閘，關著等於任何人註冊別人的信箱
  就能認領訪客訂單；好日子既有的 2 個帳號要手動補 `email_confirmed_at`。
  🔴 沒設自訂 SMTP 之前，`smtp_sender_name` 與 `rate_limit_email_sent` 改不了（HTTP 401），而且 PATCH 是
  全有全無——腳本已拆成兩組。SMTP 密碼搬不了（Supabase 存雜湊），要在 Dashboard 手填一次。

## 下一步

1. 建正式目標專案，跑 `run_rehearsal.sh <ref> --no-reset`（= `00 → … → 60` 再自動跑 `70／72／73／71`），
   另外手動跑 `data_diff.py` 三站與 `74_postgrest_checks.sh`。
2. 跑 `93`（曝露 schema）→ Dashboard 設自訂 SMTP → 跑 `92`（補寄件人與額度）→ 跑 `90`、`91`
   （排程維持 active=false，切換那一刻才 `--activate`）。
3. 各站 codebase 加 `db: { schema }`；快樂手 `listUsers` 改以 `happyhands.profiles` 過濾；小時光員工清單加
   `role in (...)`；快樂手補「登入時套用未消費 `staff_invites`」。
4. 切換順序：小時光 → 好日子 → 快樂手，各自照計畫的固定七步（排空 → 停 worker/cron → 備份快照 → 切 env →
   冒煙 → delta 重放 → 重啟），小時光那一步結束後才 `91 --activate`。
