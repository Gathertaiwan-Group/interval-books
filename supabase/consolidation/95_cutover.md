# 逐站切換 runbook（三站合併）

目標專案：`gooddays-group` / `noijrmhdfbfvjyvchvzj`（ap-northeast-1，gathertaiwan's Org）。
連線值在 `scratchpad/target_env.txt`（600，不進版控）。要看值：

```bash
cat /private/tmp/claude-501/-Users-aimand--gemini-File/<session>/scratchpad/target_env.txt
```

🔴 **三站的 env 目前都是 production＋preview＋development 共用同一組值**（實查 Vercel）。
   改的時候三個環境會一起換；不想讓 preview 跟著動就要先把 production 拆成獨立的一筆。

## 開始之前（三站共同）

0. ✅ **信件已設定好（2026-10-07）**：自訂 SMTP 走 Resend（`smtp.resend.com:465`），寄件人
   `好日子 Good Days <noreply@gathertaiwan.com>`，寄信額度 60 封／小時，六種信件模板改成中文並統一走
   `{{ .RedirectTo }}`（`auth_email_templates.py`）。已實寄三封驗證信到 Resend 測試信箱：快樂手、好日子、
   以及「沒傳 redirect 的退路」三種情況的連結都導到正確的網站，信裡的 token 也真的能完成驗證。
   - 寄件帳號是**集團自己的 Resend**（intervalbooks.tw、happyhands.com.tw 已驗證），目前寄件地址
     `noreply@intervalbooks.tw`，已用它實寄三封驗證信確認連結與 token 都正確。
   - 🟡 **好日子自己的網域 mygoodday.com.tw 還沒驗證**（Resend 狀態 not_started）。它的 DNS 在 Cloudflare，
     要補三筆紀錄（都在子網域，不影響根網域的 Google Workspace 信箱）：
     `TXT resend._domainkey`（DKIM）、`MX send → feedback-smtp.ap-northeast-1.amazonses.com`（優先 10）、
     `TXT send → v=spf1 include:amazonses.com ~all`。完整值用 Resend API `GET /domains/<id>` 取。
     驗證通過後：`92_auth_settings.py --dst noijrmhdfbfvjyvchvzj --smtp-key-file <Resend key 檔> --smtp-from noreply@mygoodday.com.tw --apply`
     （沒帶 `--smtp-key-file` 時 SMTP 欄位整組不寫，只帶 `--smtp-from` 等於沒做）。
     🔴 92 會讀三個舊專案的設定，**舊庫關掉後它就跑不了**——要在關庫前換好，不然只能直接 PATCH `smtp_admin_email`。
   - 網站端配套（已上線，對現行舊專案是 no-op）：快樂手 `cddbe1f` 把註冊與忘記密碼的 redirect 改成剛好
     `<網域>/auth/confirm`；好日子 `c2345ae` 新增 `/auth/confirm` 落地頁並在註冊時帶 redirect。小時光原本就是。
1. 🔴 **組織要先升級到 Pro**。free 方案沒有每日備份、沒有 PITR、閒置七天會自動暫停。
   這顆庫裝的是三站訂單與**已開立的電子發票**（稅務文件），沒有回復點不可以上線。
   `python3 94_check_target_plan.py --dst noijrmhdfbfvjyvchvzj` 會擋。
2. Dashboard 設好自訂 SMTP（密碼 Supabase 存的是雜湊，搬不過來），然後
   `python3 92_auth_settings.py --dst noijrmhdfbfvjyvchvzj --apply` 把寄件人「好日子 Good Days」
   與寄信額度補上。
3. 好日子原本 `mailer_autoconfirm=true`，合併後已改成要驗證信箱；**好日子既有的 2 個帳號**
   要手動補 `email_confirmed_at`，否則他們登入會被卡。
4. 重新灌一次資料（來源這幾天有新訂單就必須做）：`50_load_data.sh` 之前先跑
   `api_dump.py` 產出新的 dump，再跑 `60`、`70`、`71`、`72`、`74` 與三站 `data_diff.py`。

## 每一站的固定七步

以 **小時光 → 好日子 → 快樂手** 的順序，一站做完觀察兩週再下一站。

| # | 動作 | 為什麼 |
|---|---|---|
| 1 | T-24h：確認 `invoice_backlog()` / `count_invoice_alerts()` = 0、`email_outbox` 沒有 queued | 排空才不會在切換窗口裡有半完成的開票 |
| 2 | **先停所有 worker／cron**：Railway scale 0、Vercel cron 移除、舊庫 `update cron.job set active=false` | 🔴 防 Amego **重複開發票**：新舊兩邊各跑一次 `dispatch_invoice_task` 會對同一張單開兩張，那是要作廢的稅務文件 |
| 3 | 手動觸發一次備份，並用 `api_dump.py` 存一份該站的邏輯快照 | 這是回退的依據 |
| 4 | 切 env（下表），重新部署 | |
| 5 | 冒煙：登入、列表、選商品進到結帳頁（**不送單**）、後台訂單清單 | |
| 6 | Delta 重放：舊庫 `created_at >` 快照時間的 append-only 表搬到新庫 | 窗口內打到舊庫的 webhook 靠這步不掉 |
| 7 | 用新 env 重啟 worker；小時光這一站做完後跑 `91_cron_vault.py --activate` 開排程，盯 `cron.job_run_details` 與 `net._http_response` | |

## 各站要改的 env

值都一樣：`SUPABASE_URL` → `https://noijrmhdfbfvjyvchvzj.supabase.co`，
anon 與 service_role 用 `target_env.txt` 裡的。

| 站 | 平台 | 變數 |
|---|---|---|
| 小時光 | Vercel `interval-books`（team `lqtechs-projects`） | `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`（實查：Vercel 上**沒有** `SUPABASE_URL`，`src/server/env.ts` 的 `supabaseUrl()` 會 fallback 到 `VITE_SUPABASE_URL`，所以三個就夠。`src/lib/images.ts` 也讀 `VITE_SUPABASE_URL` 組 storage 公開網址——140 個 site-images 物件已經搬過去，改這個變數圖片就跟著換。） |
| 好日子 web | Vercel `goodday` | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` |
| 好日子 api | Railway（`interval`） | `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` |
| 快樂手 web | Vercel `happyhands` | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` |
| 快樂手 worker | Railway／Vercel cron | `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` |

🔴 **快樂手的 38 位客戶與好日子的 2 位需要重新登入**：JWT secret 與 cookie 名
（`sb-<ref>-auth-token`）都換了，舊 cookie 一律失效。事先公告。小時光的員工 cookie 是自家
iron-session、只存 userId，UUID 沒變所以不受影響。

## 回退

改回舊 env 即可，舊庫從頭到尾在原地。唯一不免費的是快樂手：切換後的新訂單要倒回舊庫，
用 `80_reverse_delta.sh`（已在丟棄式專案演練過：新增＋窗口內狀態更新＋序列同步，重跑冪等）。

## 程式改動狀態

🔴 **schema 改動只能跟切換一起上線**：快樂手與好日子的 `db:{schema}` 放在各自 repo 的
`cutover/merged-db` 分支（已 rebase 到最新 main，測試與型別檢查全過）。**不要先合進 main**——
現在推上去，網站會去舊專案找 `happyhands`／`gooddays` schema，整站讀不到資料。切換第 4 步才合併部署。

（2026-09-28 完成的內容）

- 快樂手 `5039605`：五支工廠帶 `db:{schema:"happyhands"}`、worker 的 `ServiceClient` 型別釘住 schema
  （不釘 tsc 會擋）、eslint 禁止工廠以外直接 import supabase 套件。
- 好日子 `d25cea6`：四支工廠＋`api/src/jobs.ts` 帶 `db:{schema:"gooddays"}`，另加一支靜態掃描的
  守門測試（做過變異測試會紅）。
- 小時光**不需要改**：它留在 `public`。實查四處讀 `profiles` 的地方都已經 fail-closed
  （`listStaffAccounts` 有 `role in (admin,staff,pending)`、後台與廠商登入各自只認自己的 role、
  進銷存那支用 id 清單過濾），合併後多出來的 38 個 customer 不會出現在任何後台清單。


## 實際切換（2026-10-08）

使用者決定**維持免費方案**直接切換（接受：沒有每日備份；上線後有流量不會再閒置暫停）。

一站一個指令（都在本目錄）：

```bash
python3 96_switch.py ib     # 小時光：停舊庫排程 → 改 Vercel env → 重新部署 → 煙霧測試 → 開新庫排程
python3 96_switch.py gd     # 好日子：Vercel env → Railway env（先不部署）→ 合併 cutover 分支推上 → 等上線 → Railway 部署同一 commit → 煙霧測試
python3 96_switch.py hh     # 快樂手：Vercel env → 合併 cutover 分支推上 → 等上線 → 煙霧測試
python3 sync_delta.py --apply   # 切換窗口內寫進舊庫的資料補過來（只新增／更新，不刪）
```

切換前已用 `sync_delta.py` 把合併庫補到與三站一致（小時光 +1 帳號、24 筆寄信佇列狀態；快樂手 Alice 的 owner 角色與稽核）。
清空重灌被 auto-mode 權限檢查以「大量刪除」擋下，所以改成只補差異——反而更快，也能重複跑。

## 關閉舊庫前的確認清單（舊庫關掉就沒有回退路線）

1. 三站 `96_switch.py` 都 ✅（頁面 200、網站程式指向新庫）。
2. 切換後跑 `sync_delta.py --apply`，再跑一次試跑確認全部 0。
3. 觀察 24–48 小時：`cron.job_run_details` 的三個排程有成功紀錄、`net._http_response` 沒有 4xx/5xx、有訂單的話確認金流 webhook 寫進新庫、驗證信能收到。
4. **關庫前最後再備份一次**（切換到關閉之間舊庫若還有寫入）。目前備份：
   `~/supabase-backups/2026-10-08-pre-shutdown/`（三站資料＋Auth、結構 DDL、Auth／PostgREST 設定、Storage 206 個檔，權限 700）。
5. 舊庫關掉後**會失效且救不回來**的：已寄出的信、LINE、Google 索引裡指向舊 Storage 網址的圖（快樂手 media、好日子 product-images）。Supabase 不提供轉址。
6. 本機 `happyhand/supabase/.temp` 還連著舊庫：關掉後 `supabase db push` 會失敗（安全）。
   🔴 不要把快樂手／好日子的 repo 重新 link 到新專案跑 `db push`——它們的 migration 是寫給 public 的，會直接套進小時光的 schema。
7. 小時光自檢腳本的線上實測預設已改指新專案（小時光的表在新專案仍是 public／inv）。
8. 好日子寄件地址要換成 mygoodday.com.tw 的話，**關庫前做**（`92_auth_settings.py` 要讀舊專案，見上方 Auth 那段）。


## ✅ 切換完成（2026-10-08）

| 站 | 怎麼切的 | 結果 |
|---|---|---|
| 好日子 | `96_switch.py gd`：Vercel env＋Railway env（skipDeploys）→ 合併 cutover 分支 → Vercel 與 Railway 都部署 173c737 | 頁面 200、網站程式指向新庫、Railway api SUCCESS |
| 快樂手 | `96_switch.py hh`：Vercel env → 合併 cutover 分支 39d2cac → 部署 | 頁面 200、網站程式指向新庫 |
| 小時光 | 重新部署被 Vercel 擋下（@tanstack/react-start 1.167.39 有 CVE-2026-102989，Vercel 拒絕建置有已知漏洞的套件）→ 升級到 1.168.60（77f99fb）後推上去，同一次部署拿到新 env | 頁面 200、網站程式指向新庫 |

- 切換前後各跑一次 `sync_delta.py`：切換窗口內三站舊庫都沒有新寫入，不需要補。
- 舊小時光庫的三個排程已停；新庫三個排程已開，第一輪全部 succeeded，打到網站任務端點都回 200。
- ⚠️ 小時光第一次重新部署失敗時，舊排程已先被停掉，停了約兩小時才恢復；期間訂單逾期、補開發票、寄信都沒跑，恢復後下一輪會補上。
- 10/8 補：好日子 Vercel 還掛著 `goodday-tw.vercel.app`，它不在 Auth 白名單裡，從那個網址註冊的人，驗證信會把他導到小時光。已加進白名單（`92_auth_settings.py` 的 EXTRA_ALLOW），前後讀回比對：只多這一筆、其他沒少。
  好日子正式網址是 `https://interval-livid.vercel.app`（`NEXT_PUBLIC_SITE_URL`），後台 `/admin`。`mygoodday.com.tw` 沒有掛在 Vercel 上，目前連線會逾時。
- 三個舊專案目前仍在運作但已沒有網站在用。**關閉前請照上面的「關閉舊庫前的確認清單」。**


## 🔍 關庫前檢查（2026-10-09）——結論：沒有漏搬的資料，可以關

| 檢查 | 怎麼查 | 結果 |
|---|---|---|
| 業務資料 | `sync_delta.py` 試跑：每張表主鍵＋整列 md5，舊 vs 新 | 三站全部一致；序列都齊 |
| 帳號 | 同上（auth.users／identities，重複帳號按 remap 比） | 9＋37＋1 個全在。唯一差異是 Alice（0a68e409）：**新庫比較新**（10/8 12:13 在新庫登入、10/9 01:52 在新庫改密碼） |
| 全庫盤點 | 舊庫**所有 schema** 每張表 `count(*)` 對新庫 | 小時光 60/60、快樂手 20/20、好日子 16/17 新庫列數 ≥ 舊庫 |
| Storage | `90_storage_migrate.py --verify-only`：逐檔下載比大小＋md5 | 8 個桶、206 個檔全部一致，桶設定一致 |
| 切換後舊庫有沒有被用 | auth.sessions／refresh_tokens、storage.objects、pg_stat_activity、cron.job_run_details | 沒有新登入／刷新 token、沒有新檔、沒有外部直連、舊排程停用且 0 次執行 |
| 切換後舊庫有沒有被寫 | 重新 dump 三站，和 10/8 09:18（切換前）的備份逐位元比 | 資料與帳號完全相同；只有好日子一個併掉的重複帳號（b27a6933）的 `updated_at` 變了 |
| 外部設定 | Vercel 三站所有環境的變數（金鑰解 JWT 看 ref）、Railway 全部服務、三個 repo | 全部指向新庫；Railway 只有好日子 `interval/api` 用 Supabase |

**刻意沒搬的（都在最終備份裡）**：好日子 `public._migrations`（11 列，舊專案自建的 migration 帳本）、
快樂手 `supabase_migrations.schema_migrations`（21 列，CLI 的 migration 紀錄）、小時光 `cron.job_run_details`
（30,634 筆舊排程執行紀錄）、`net._http_response`（pg_net 暫存，幾小時就自動清）。

**最終備份**：`~/supabase-backups/2026-10-09-final/`（三站資料＋帳號＋上面那些歷史表，權限 700）。
Storage、DDL、Auth／PostgREST 設定沿用 `2026-10-08-pre-shutdown/`（切換後都沒變）。

⚠️ 這次發現、已處理或要知道的：
- **快樂手 CI 的 `migrate` job（push main 就 `supabase link` + `db push`）已移除**（happyhand `151ce43`）。它的 secret 指向舊專案：
  關庫後每次 push 都會失敗；若有人把 secret 改成新專案，db push 會把寫給 public 的 21 支 migration 重放進小時光的 schema。
  切換那次它對舊庫回報 `Remote database is up to date`，沒套任何東西。GitHub secrets
  `SUPABASE_PROJECT_ID`／`SUPABASE_DB_PASSWORD`／`SUPABASE_ACCESS_TOKEN` 已經沒人用，可以刪。
- 好日子 `scripts/provision.mjs`（`npm run provision`）只有手動才會跑，但它用 `PROJECT_NAME` 找 Supabase 專案、
  找不到就**新建一個並把 Vercel 的 env 改指過去**；指到合併專案則會把 migration 套進 public、改集團的 Auth 設定。**不要跑。**
- `auth.audit_log_entries` 在這幾個專案是**空的**（稽核紀錄沒寫進 DB），不能拿來判斷有沒有人登入；改看 sessions／refresh_tokens。
- Management API 的 `logs.all` 已在 2026-09-23 移除，新的 `/analytics/endpoints/logs` 是 ClickHouse SQL
  （`FROM logs WHERE source_name = 'edge_logs'`、`log_attributes['request.path']`）；這幾個專案連 `count()` 都回
  `Backend error`，請求紀錄只能到 Dashboard 的 Logs Explorer 看。
- mygoodday.com.tw 寄件地址若在關庫後才換：92 讀不到舊專案會停下，改成直接 PATCH `smtp_admin_email`（加 `smtp_pass`）即可。


## 🗑️ 舊庫已刪除（2026-10-09 約 12:30）＋刪除後檢查

三個舊專案 Management API 都回 404。刪除後：新專案五項服務 ACTIVE_HEALTHY；三站各爬 11–13 頁全 200、沒有任何頁面含舊庫網址、
公開商品（22／6／20）的名稱都出現在頁面上、頁面引用的新庫圖片抽查全 200；三站後台都正常導到登入頁；
新庫排程 12:40／12:43／12:45 都 succeeded、打網站回 200；好日子 Railway api（173c737）log 無錯誤；快樂手 CI 重跑通過。

- 🔴 **合併專案是 free 方案，沒有平台的每日備份**，舊庫（Pro）刪掉後唯一的備份是本機 `~/supabase-backups/2026-10-09-final/`。
- `sync_delta.py`、`92_auth_settings.py`（預設讀舊專案）、`data_diff.py` 對舊專案的用法從此都跑不了。
- 本機開發用的 `alice-store/.env.local`、`happyhand/apps/web/.env.local` 還指舊庫（只影響在本機跑網站，正式站不受影響）；
  `happyhand/supabase/.temp` 也還連舊庫——不要改連新專案。
