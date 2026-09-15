#!/usr/bin/env bash
# 81_reverse_delta_drill.sh — 在丟棄式專案上演練 80：造一個仿舊庫 schema、在新庫寫切換後的假資料，跑兩次 80 驗冪等。
#   NEW_URL=… ./81_reverse_delta_drill.sh
#
# 設計上只碰自己造的 DRILL 列（訂單編號 DRILL-%、信件 dedupe_key drill-%），結束時全部刪掉，
# 真實資料完全不動——所以演練前後 data_diff.py 的結果應該一樣。
# 流程：先種兩筆「切換前就存在」的 DRILL 訂單 → 建 hh_old（＝切換那一刻的舊庫快照）→ 記下切換時間 →
#       造窗口內的新增（3 筆新訂單＋明細＋付款事件＋信）與更新（那兩筆翻成 paid，模擬 webhook）→ 跑兩次 80。
set -euo pipefail
: "${NEW_URL:?}"
here=$(cd "$(dirname "$0")" && pwd)
TABLES="orders order_items payment_events entitlements seat_holds email_outbox ai_chat_logs audit_log"
psql() { command psql "$@"; }
run() { command psql "$NEW_URL" -v ON_ERROR_STOP=1 -q "$@"; }
val() { command psql "$NEW_URL" -Atc "$1"; }

cleanup() {
  run <<'SQL'
set session_replication_role = replica;
delete from happyhands.payment_events where order_id in (select id from happyhands.orders where order_no like 'DRILL-%');
delete from happyhands.order_items   where order_id in (select id from happyhands.orders where order_no like 'DRILL-%');
delete from happyhands.orders        where order_no like 'DRILL-%';
delete from happyhands.email_outbox  where dedupe_key like 'drill-%';
drop schema if exists hh_old cascade;
SQL
}
echo "═══ 0. 清掉上一次演練的殘留（可重複執行）"; cleanup

echo "═══ 1. 種兩筆「切換前就存在」的 DRILL 訂單"
run <<'SQL'
set session_replication_role = replica;
insert into happyhands.orders
select (jsonb_populate_record(null::happyhands.orders,
        to_jsonb(o) || jsonb_build_object('id', gen_random_uuid()::text, 'order_no', 'DRILL-OLD-'||g,
          'status', 'pending', 'payment_status_code', null, 'paid_at', null,
          'created_at', (now() - interval '1 day')::text, 'updated_at', (now() - interval '1 day')::text))).*
from (select * from happyhands.orders order by created_at limit 1) o, generate_series(1,2) g;
SQL

echo "═══ 2. 建仿舊庫 hh_old（結構＋切換前資料）"
{ echo "drop schema if exists hh_old cascade; create schema hh_old;"
  for t in $TABLES; do
    c=$(val "select string_agg(quote_ident(attname), ', ' order by attnum) from pg_attribute where attrelid='happyhands.$t'::regclass and attnum>0 and not attisdropped and attgenerated=''")
    # 🔴 不能 select *：ai_chat_logs.has_contact 是 generated column；audit_log.id 是 GENERATED ALWAYS identity
    ovr=$(val "select case when count(*)=0 then '' else 'overriding system value' end from pg_attribute where attrelid='happyhands.$t'::regclass and attidentity='a' and attnum>0")
    echo "create table hh_old.$t (like happyhands.$t including all);"
    echo "insert into hh_old.$t ($c) $ovr select $c from happyhands.$t;"
  done
} | run
CUTOVER=$(val "select now()::text"); echo "  切換時間點 = $CUTOVER"
val "select '  hh_old.orders='||(select count(*) from hh_old.orders)||' order_items='||(select count(*) from hh_old.order_items)"

echo "═══ 3. 造窗口內的增量（複製既有列、換掉主鍵與唯一鍵；jsonb 覆寫，免逐表寫欄位）"
run <<'SQL'
set session_replication_role = replica;
-- 新訂單
insert into happyhands.orders
select (jsonb_populate_record(null::happyhands.orders,
        to_jsonb(o) || jsonb_build_object('id', gen_random_uuid()::text, 'order_no', 'DRILL-NEW-'||g,
          'status', 'pending', 'created_at', now()::text, 'updated_at', now()::text, 'paid_at', null))).*
from (select * from happyhands.orders where order_no not like 'DRILL-%' order by created_at limit 1) o, generate_series(1,3) g;
-- 明細
insert into happyhands.order_items
select (jsonb_populate_record(null::happyhands.order_items,
        to_jsonb(i) || jsonb_build_object('id', gen_random_uuid()::text, 'order_id', o.id::text, 'created_at', now()::text))).*
from (select * from happyhands.order_items limit 1) i, happyhands.orders o where o.order_no like 'DRILL-NEW-%';
-- 付款事件：trans_id 也要換，payment_events 有唯一索引 (provider, trans_id, status_code)——它是 index 不是 constraint，
-- 正是 80 用「不指定目標的 on conflict do nothing」的理由（指定主鍵當仲裁鍵會被這個索引擋下來丟例外）
insert into happyhands.payment_events
select (jsonb_populate_record(null::happyhands.payment_events,
        to_jsonb(p) || jsonb_build_object('id', gen_random_uuid()::text, 'order_id', o.id::text,
          'trans_id', 'DRILL'||substr(o.id::text, 1, 8), 'created_at', now()::text))).*
from (select * from happyhands.payment_events limit 1) p, happyhands.orders o where o.order_no like 'DRILL-NEW-%';
-- 信
insert into happyhands.email_outbox
select (jsonb_populate_record(null::happyhands.email_outbox,
        to_jsonb(e) || jsonb_build_object('id', gen_random_uuid()::text, 'dedupe_key', 'drill-'||g,
          'created_at', now()::text, 'updated_at', now()::text))).*
from (select * from happyhands.email_outbox limit 1) e, generate_series(1,2) g;
-- 🔴 最重要的一類：切換前就存在的訂單，窗口內被 webhook 改成 paid（只搬新增會把這筆錢丟掉）
update happyhands.orders set status='paid', payment_status_code='DRILL-OK', paid_at=now(), updated_at=now()
 where order_no like 'DRILL-OLD-%';
SQL
val "select '  新增 '||(select count(*) from happyhands.orders where order_no like 'DRILL-NEW-%')||' 筆、窗口內改狀態 '||(select count(*) from happyhands.orders where payment_status_code='DRILL-OK')||' 筆'"

echo; echo "═══ 4. 第一次跑 80"
CUTOVER="$CUTOVER" NEW_URL="$NEW_URL" OLD_URL="$NEW_URL" NEW_SCHEMA=happyhands OLD_SCHEMA=hh_old "$here/80_reverse_delta.sh"
echo; echo "═══ 5. 第二次跑 80（冪等：新增應全部略過、更新寫回同值）"
CUTOVER="$CUTOVER" NEW_URL="$NEW_URL" OLD_URL="$NEW_URL" NEW_SCHEMA=happyhands OLD_SCHEMA=hh_old "$here/80_reverse_delta.sh"

echo; echo "═══ 6. 驗收"
command psql "$NEW_URL" -v ON_ERROR_STOP=1 -c "
select t, new_n, old_n, case when new_n = old_n then '✅' else '❌' end ok from (
  $(for t in $TABLES; do echo "select '$t' t, (select count(*) from happyhands.$t) new_n, (select count(*) from hh_old.$t) old_n union all"; done | sed '$ s/union all$//')
) x order by t;"
for chk in \
  "select 'DRILL 新訂單進舊庫 '||count(*)||'（期望 3）' from hh_old.orders where order_no like 'DRILL-NEW-%'" \
  "select '付款狀態跟上 '||count(*)||'（期望 2）' from hh_old.orders where payment_status_code='DRILL-OK' and status='paid'" \
  "select 'orders 整表 md5 相同：'||((select md5(string_agg(x, chr(10) order by x)) from (select t::text x from happyhands.orders t) a) = (select md5(string_agg(x, chr(10) order by x)) from (select t::text x from hh_old.orders t) b))" \
  "select 'order_items md5 相同：'||((select md5(string_agg(x, chr(10) order by x)) from (select t::text x from happyhands.order_items t) a) = (select md5(string_agg(x, chr(10) order by x)) from (select t::text x from hh_old.order_items t) b))" \
  "select 'audit_log 序列已對齊：'||(select last_value >= coalesce((select max(id) from hh_old.audit_log),0) from hh_old.audit_log_id_seq)" ; do
  val "$chk" | sed 's/^/  /'
done

echo; echo "═══ 7. 清場（刪掉所有 DRILL 列與 hh_old，真實資料回到演練前）"; cleanup
val "select '  happyhands.orders='||(select count(*) from happyhands.orders)||'（期望 38）｜殘留 DRILL 列='||(select count(*) from happyhands.orders where order_no like 'DRILL-%')"
