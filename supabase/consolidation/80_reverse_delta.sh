#!/usr/bin/env bash
# 80_reverse_delta.sh — 快樂手回退專用：把「切換後」寫進新庫的增量倒回舊庫，讓 env 切回去之後不掉單。
#
#   CUTOVER='2026-10-01 01:00:00+08' NEW_URL=… OLD_URL=… [NEW_SCHEMA=happyhands] [OLD_SCHEMA=public] ./80_reverse_delta.sh
#
# 兩個階段：
#   A 新增：created_at > CUTOVER 的列，父表在前，`on conflict do nothing`（不指定目標鍵）。
#     🔴 不寫 `on conflict (id)`：entitlements 的主鍵是 (user_id, product_id) 根本沒有 id；而 orders.order_no、
#        email_outbox.dedupe_key、ai_chat_logs.session_id 這些次要 unique 若撞上（回退窗口內兩邊各自發號很可能撞），
#        指定了 id 當仲裁鍵會直接丟 unique violation 中斷，不指定才會整列跳過。跳過的列數會印出來，不會靜默。
#   B 更新：切換前就存在、但窗口內被改過（updated_at > CUTOVER）的列——最重要的是**付款狀態**：
#        webhook 打進新庫把 orders 從 pending 翻成 paid，只搬新增會把這筆錢丟掉。以主鍵 upsert 整列。
#
# 兩邊都在 session_replication_role = replica 下寫入：不觸發 set_updated_at／audit trigger（時間戳保持新庫的真值），
# 也不檢查 FK（父列可能還沒倒回來；階段 A 已按父表在前排序，收尾再驗一次孤兒）。
# 重跑冪等：階段 A 全部跳過、階段 B 寫回同樣的值。
set -euo pipefail
: "${CUTOVER:?}" "${NEW_URL:?}" "${OLD_URL:?}"
NEW_SCHEMA=${NEW_SCHEMA:-happyhands}; OLD_SCHEMA=${OLD_SCHEMA:-public}

# 父表在前。清單是 2026-09-15 對快樂手 schema 實查的結果（有 created_at、切換後會新增的表）；快樂手加表要回來補。
INSERT_TABLES=${INSERT_TABLES:-"orders order_items payment_events entitlements seat_holds email_outbox ai_chat_logs audit_log"}
# 會被「就地改狀態」的表（除了新增還要搬更新）
UPDATE_TABLES=${UPDATE_TABLES:-"orders order_items entitlements email_outbox"}

newq() { psql "$NEW_URL" -v ON_ERROR_STOP=1 -Atc "$1"; }
cols_of() { newq "select string_agg(quote_ident(attname), ', ' order by attnum) from pg_attribute where attrelid='$NEW_SCHEMA.$1'::regclass and attnum>0 and not attisdropped and attgenerated=''"; }
pk_of()   { newq "select string_agg(quote_ident(a.attname), ', ' order by k.ord) from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum where c.conrelid='$NEW_SCHEMA.$1'::regclass and c.contype='p'"; }
# 🔴 GENERATED ALWAYS AS IDENTITY 的欄位（快樂手只有 audit_log.id）：COPY 進暫存表沒事，
#    但 `insert into … select` 會被擋（ERROR: cannot insert a non-DEFAULT value into column "id"），要加 OVERRIDING SYSTEM VALUE。
ovr_of()  { [ "$(newq "select count(*) from pg_attribute where attrelid='$NEW_SCHEMA.$1'::regclass and attidentity='a' and attnum>0")" = 0 ] && echo '' || echo 'overriding system value'; }

echo "═══ A. 新增（created_at > $CUTOVER）"
for t in $INSERT_TABLES; do
  cols=$(cols_of "$t"); ovr=$(ovr_of "$t")
  [ -n "$cols" ] || { echo "❌ $NEW_SCHEMA.$t 不存在"; exit 1; }
  sent=$(newq "select count(*) from $NEW_SCHEMA.$t where created_at > '$CUTOVER'")
  ins=$(psql "$NEW_URL" -Atc "copy (select $cols from $NEW_SCHEMA.$t where created_at > '$CUTOVER' order by created_at) to stdout" \
    | psql "$OLD_URL" -v ON_ERROR_STOP=1 -Atc "
        set session_replication_role = replica;
        create temp table _in (like $OLD_SCHEMA.$t including defaults) on commit drop;
        copy _in ($cols) from stdin;
        with done as (insert into $OLD_SCHEMA.$t ($cols) $ovr select $cols from _in on conflict do nothing returning 1)
        select count(*) from done;" | tail -1)
  skipped=$((sent - ins))
  printf '  %-15s 新庫 %3s 列 → 寫入 %3s，略過 %s%s\n' "$t" "$sent" "$ins" "$skipped" "$([ "$skipped" -gt 0 ] && echo '（已存在或撞次要 unique，重跑時正常）')"
done

echo "═══ B. 更新（updated_at > $CUTOVER 且切換前就存在）"
for t in $UPDATE_TABLES; do
  cols=$(cols_of "$t"); pk=$(pk_of "$t"); ovr=$(ovr_of "$t")
  [ -n "$pk" ] || { echo "❌ $NEW_SCHEMA.$t 沒有主鍵，無法 upsert"; exit 1; }
  set_list=$(newq "select string_agg(quote_ident(attname)||' = excluded.'||quote_ident(attname), ', ' order by attnum) from pg_attribute where attrelid='$NEW_SCHEMA.$t'::regclass and attnum>0 and not attisdropped and attgenerated='' and attname <> all(string_to_array(replace('$pk',' ',''), ','))")
  sent=$(newq "select count(*) from $NEW_SCHEMA.$t where updated_at > '$CUTOVER' and created_at <= '$CUTOVER'")
  upd=$(psql "$NEW_URL" -Atc "copy (select $cols from $NEW_SCHEMA.$t where updated_at > '$CUTOVER' and created_at <= '$CUTOVER' order by updated_at) to stdout" \
    | psql "$OLD_URL" -v ON_ERROR_STOP=1 -Atc "
        set session_replication_role = replica;
        create temp table _up (like $OLD_SCHEMA.$t including defaults) on commit drop;
        copy _up ($cols) from stdin;
        with done as (insert into $OLD_SCHEMA.$t ($cols) $ovr select $cols from _up on conflict ($pk) do update set $set_list returning 1)
        select count(*) from done;" | tail -1)
  printf '  %-15s 窗口內被改過 %3s 列 → 寫回 %3s\n' "$t" "$sent" "$upd"
done

echo "═══ C. 序列同步（明寫 id 不會推進序列；不補的話舊庫下一筆 insert 會撞主鍵）"
for t in $INSERT_TABLES; do
  psql "$OLD_URL" -v ON_ERROR_STOP=1 -Atc "
    do \$\$ declare r record; begin
      for r in select a.attname, pg_get_serial_sequence('$OLD_SCHEMA.$t', a.attname) sq
               from pg_attribute a where a.attrelid='$OLD_SCHEMA.$t'::regclass and a.attnum>0 and not a.attisdropped
                 and pg_get_serial_sequence('$OLD_SCHEMA.$t', a.attname) is not null loop
        execute format('select setval(%L, coalesce((select max(%I) from %I.%I), 0) + 1, false)', r.sq, r.attname, '$OLD_SCHEMA', '$t');
        raise notice '  % 序列 % 已對齊', '$t', r.sq;
      end loop;
    end \$\$;" 2>&1 | grep -v '^$' || true
done

echo "═══ D. 收尾檢查（replica 模式跳過 FK，這裡補驗孤兒 order_items）"
psql "$OLD_URL" -Atc "select '孤兒 order_items = '||count(*) from $OLD_SCHEMA.order_items i where not exists (select 1 from $OLD_SCHEMA.orders o where o.id = i.order_id)"
echo "done — 再跑一次 data_diff.py 比對兩邊列數／md5"
