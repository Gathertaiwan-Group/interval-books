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
     驗證通過後：`92_auth_settings.py --smtp-from noreply@mygoodday.com.tw --apply`。
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
