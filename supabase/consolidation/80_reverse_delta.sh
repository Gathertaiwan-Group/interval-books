#!/usr/bin/env bash
# 80_reverse_delta.sh — 快樂手回退專用：把「切換後」寫進新庫的增量倒回舊庫，讓 env 切回去之後不掉單。
# 骨架；Phase 1 排練時要對著丟棄式專案真的跑一次（寫幾筆假單 → 跑 → 舊庫拿得到且重跑不重複）。
#   用法：CUTOVER='2026-10-01 01:00:00+08' NEW_URL=... OLD_URL=... ./80_reverse_delta.sh
set -euo pipefail
: "${CUTOVER:?}" "${NEW_URL:?}" "${OLD_URL:?}"
# append-only 表，父表在前；每張以自然鍵 on conflict do nothing 保證冪等
for spec in \
  "orders:id" "order_items:id" "payment_events:id" "entitlements:id" "seat_holds:id" \
  "email_outbox:id" "ai_chat_logs:id" "audit_log:id"; do
  t=${spec%%:*}; k=${spec##*:}
  echo "== $t (created_at > $CUTOVER)"
  psql "$NEW_URL" -Atc "copy (select * from happyhands.$t where created_at > '$CUTOVER') to stdout" \
   | psql "$OLD_URL" -c "create temp table _in (like public.$t); copy _in from stdin; insert into public.$t select * from _in on conflict ($k) do nothing; drop table _in;"
done
echo "done — 回頭在舊庫跑 70 的第 9 段比對列數"
