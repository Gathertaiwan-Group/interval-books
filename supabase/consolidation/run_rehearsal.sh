#!/usr/bin/env bash
# run_rehearsal.sh <目標 ref> — 從零跑完整套：reset → 00 → 10 → 20 → 30 → 40 → 50 → 60 → 70。
#   NEW_URL 由 pg_rehearsal.url 讀（psql 用），ref 給 Management API 用。log 落在 scratchpad。
#   ⚠️ 只對丟棄式／全新的目標專案跑；reset 會清光 public 與 inv。
set -euo pipefail
ref=${1:?用法: run_rehearsal.sh <ref>}
SP=${SP:-/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad}
here=$(cd "$(dirname "$0")" && pwd); export NEW_URL="$(cat "$SP/pg_rehearsal.url")"
step() { echo; echo "───── $* ─────"; }
step "reset（清空目標）";      python3 "$SP/q.py" "$ref" "@$SP/rehearsal_reset.sql"
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
