#!/usr/bin/env bash
# run_rehearsal.sh <目標 ref> [--no-reset] — 跑完整套：[reset →] 00 → 10 → 20 → 30 → 40 → 50 → 60 → 70 → 72 → 73 → 71。
#   NEW_URL 由 pg_rehearsal.url 讀（psql 用；正式目標請改成該專案的連線字串），ref 給 Management API 用。
#   🔴 reset 會清光 public 與 inv，只能對丟棄式／全新專案跑。正式目標請加 --no-reset。
#   Storage／cron／vault／Auth 不在這支裡（90／91／92 各自跑，順序見 README）。
set -euo pipefail
set -o pipefail   # 🔴 每個步驟都接 grep／tail，沒有 pipefail 的話步驟失敗會被管線的結束碼蓋掉，整套「成功」跑完卻什麼都沒做
ref=${1:?用法: run_rehearsal.sh <ref> [--no-reset]}
do_reset=1; [ "${2:-}" = "--no-reset" ] && do_reset=0
SP=${SP:-/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad}
here=$(cd "$(dirname "$0")" && pwd)
# 連線字串：優先吃環境變數，其次 pg_target.url（正式目標），最後 pg_rehearsal.url（丟棄式排練）
if [ -z "${NEW_URL:-}" ]; then
  for f in pg_target.url pg_rehearsal.url; do [ -s "$SP/$f" ] && { NEW_URL="$(cat "$SP/$f")"; break; }; done
fi
: "${NEW_URL:?找不到連線字串（設 NEW_URL，或放 scratchpad/pg_target.url）}"; export NEW_URL
step() { echo; echo "───── $* ─────"; }
if [ "$do_reset" = 1 ]; then
  step "reset（清空目標）";    python3 "$here/q.py" "$ref" "@$here/rehearsal_reset.sql"
else
  step "略過 reset（正式目標）"
fi
# 🔴 grep 不接 terminal 時是區塊緩衝，不加 --line-buffered 會讓長步驟看起來像卡住（00 載入約五分鐘）
step "00 小時光 baseline";     "$here/00_load_baseline.sh"      2>&1 | grep --line-buffered -v 'NOTICE\|^ *$\|set_config\|^-\+$\|(1 row)'
step "10 happyhands";          python3 "$here/run_sql.py" "$ref" "$here/10_happyhands.sql"      | tail -1
step "20 gooddays";            python3 "$here/run_sql.py" "$ref" "$here/20_gooddays.sql"        | tail -1
step "30 gooddays grants";     python3 "$here/run_sql.py" "$ref" "$here/30_gooddays_grants.sql" | tail -1
step "40 auth triggers";       python3 "$here/run_sql.py" "$ref" "$here/40_auth_triggers.sql"   | tail -1
step "50 資料載入";            "$here/50_load_data.sh" 2>&1 | grep --line-buffered -E 'auth:|載入$|profiles:|^auth.users|^期望|行 public'
step "60 URL 改寫";            psql "$NEW_URL" -v ON_ERROR_STOP=1 -v new_ref="$ref" -v old_hh=soglfvjtysqqqzbcwwci -v old_gd=xptltqokykpmiqwlnasm -f "$here/60_url_rewrite.sql" | grep --line-buffered -v '^ *$'
step "70 驗證";                psql "$NEW_URL" -v ON_ERROR_STOP=1 -f "$here/70_verify.sql" 2>&1 | grep --line-buffered -v '^ *$'
step "72 權限比對";            python3 "$here/72_grant_parity.py" --src soglfvjtysqqqzbcwwci --src-schema public --dst "$ref" --dst-schema happyhands --ignore happyhands_on_auth_user_created | tail -1
                               python3 "$here/72_grant_parity.py" --src xptltqokykpmiqwlnasm --src-schema public --dst "$ref" --dst-schema gooddays --ignore gooddays_on_auth_user_created --ignore _migrations --ignore is_admin | tail -1
                               python3 "$here/72_grant_parity.py" --src xptltqokykpmiqwlnasm --src-schema private --dst "$ref" --dst-schema gooddays_private | tail -1
step "73 schema 逐字比對";     "$here/schema_diff.sh" kmpwughmwpdzsizrxhms "$ref" public inv
step "71 行為驗證";            psql "$NEW_URL" -v ON_ERROR_STOP=1 -f "$here/71_behaviour_checks.sql" 2>&1 | grep --line-buffered -v '^ *$'
