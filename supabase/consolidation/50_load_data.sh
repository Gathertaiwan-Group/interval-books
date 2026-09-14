#!/usr/bin/env bash
# 50 — 三站資料載入目標專案（骨架：順序與意圖已定，每步的實作在有連線字串後補、並在丟棄式專案排練兩次）。
#   用法：IB_URL=… HH_URL=… GD_URL=… NEW_URL=… ./50_load_data.sh
set -euo pipefail
: "${IB_URL:?}" "${HH_URL:?}" "${GD_URL:?}" "${NEW_URL:?}"

# 步驟 1  auth 帳號：三站的 auth.users 與 auth.identities。
#         🔴 欄位要明列（confirmed_at 是 generated column，塞了會錯）；不搬 sessions／refresh_tokens／
#         audit_log_entries／flow_state（切換後重新登入，比搬 session 安全）。
# 步驟 2  重複 email 的 remap：小時光的 UUID 為正本（Phase 0：3 個重複、都是員工）；
#         被合併的那幾列不載入，寫成 old→canonical 對照表。
# 步驟 3  載入 auth.users → 40 的三個 trigger 會自動在三個 schema 各建一列 profile → 再載 auth.identities。
# 步驟 4  業務表：三站 pg_dump --data-only；另兩站 sed 換 schema 名；載入時 session_replication_role=replica
#         （不觸發 set_updated_at／audit）。🔴 profiles 不從 dump 載（trigger 已建）→ 改用 update 回填
#         role／tier／points 等欄位。好日子的 _migrations 表不搬。
# 步驟 5  FK remap：對照表裡每一組，把快樂手 10 條、好日子（經 profiles）指向舊 UUID 的欄位改成正本；
#         好日子要「先 insert 正本 profile → update 子表 → delete 舊 profile」。
# 步驟 6  序列現值：確認各 schema 的 sequence 都推到 max(id)（pg_dump --data-only 會帶 setval，逐一核對）。
echo "骨架；步驟 1–6 的實作與排練待連線字串。"
