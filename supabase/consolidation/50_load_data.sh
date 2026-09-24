#!/usr/bin/env bash
# 50 — 三站資料載入目標。吃 scratchpad 裡的七個 dump（api_dump.py 產的，格式＝pg_dump --data-only；真的用 pg_dump 也一樣吃）。
#   順序：remap → auth（每站載入前快照、濾重複）→ 業務表（replica）→ profiles 覆蓋回填 → 列數。
#   用法：NEW_URL="$(cat …/pg_rehearsal.url)" ./50_load_data.sh
#   ⚠️ 第 1 步的 sed 是對 UUID（32 個十六進位字元＋連字號）做全域替換，那是安全的；
#      但**不要**用 sed 改 schema 名，BSD sed 沒有 \b（見第 3 步的 rename_schema）。
set -euo pipefail
SP=${SP:-/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad}
: "${NEW_URL:?}"; W=$(mktemp -d); echo "工作目錄 $W"

# 1. 重複帳號 remap：對快樂手／好日子的 dump（資料＋auth）做 UUID 全域替換 old→canonical。
#    UUID 是全域唯一字串，純文字替換不會誤傷（連 jsonb 裡的引用也一起對）。替換後那幾列在 auth dump 裡
#    會與小時光重複，第 2 步濾掉。
cp "$SP"/dump_{hh,gd}_{data,auth}.sql "$W/"
while IFS=$'\t' read -r site old canon; do
  [ -z "${old:-}" ] && continue
  # 🔴 這個防呆要精確：sed 會把 old 當成全域字串替換，萬一 remap.tsv 寫錯（例如放了 email）
  #    會把整份 dump 改爛。之前寫成 [0-9a-f]????????-* 少算一個字元位，結果把正確的 UUID 也擋掉。
  case "$old" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) echo "❌ remap.tsv 的 old 不是 UUID：$old"; exit 1;;
  esac
  for f in "$W/dump_${site}_data.sql" "$W/dump_${site}_auth.sql"; do sed -i '' "s/$old/$canon/g" "$f"; done
done < "$SP/remap.tsv"

# 2. auth：小時光原樣載入；快樂手／好日子逐站——先快照「載入前已存在的帳號」，users 段以 id、identities 段以
#    user_id 對照快照濾掉（欄位位置從 COPY 的欄位清單解析，不假設順序），再載入。
psql "$NEW_URL" -v ON_ERROR_STOP=1 -q -f "$SP/dump_ib_auth.sql"
python3 - "$W" "$NEW_URL" <<'PY'
import sys, subprocess, re
W, URL = sys.argv[1], sys.argv[2]
def ids_now():
    return set(subprocess.run(['psql', URL, '-Atc', 'select id from auth.users'], capture_output=True, text=True, check=True).stdout.split())
for s in ('hh', 'gd'):
    have = ids_now()                      # 🔴 快照：這一站載入前的帳號；不在迴圈中更新，否則會把本站自己的 identities 濾光
    out, col, drop = [], None, 0
    for line in open(f'{W}/dump_{s}_auth.sql').read().split('\n'):
        m = re.match(r'^COPY (\S+) \(([^)]*)\)', line)
        if m:
            cols = [c.strip().strip('"') for c in m.group(2).split(',')]
            col = cols.index('id' if m.group(1).endswith('.users') else 'user_id')
            out.append(line); continue
        if line == '\\.': col = None; out.append(line); continue
        if col is not None and line and line.split('\t')[col] in have: drop += 1; continue
        out.append(line)
    open(f'{W}/dump_{s}_auth.filtered.sql', 'w').write('\n'.join(out))
    subprocess.run(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f'{W}/dump_{s}_auth.filtered.sql'], check=True)
    print(f'  {s} auth: 濾掉重複 {drop} 列，載入完成')
PY
psql "$NEW_URL" -Atc "select 'auth.users='||count(*)||'（期望 46）' from auth.users"
# ↑ 40 的三個 trigger 已對每個帳號在三個 schema 各建一列 profile 空殼

# 3. 業務表（replica 模式不觸發 updated_at／audit）；profiles 與好日子 _migrations 的 COPY 段先抽掉。
strip_copy() { python3 - "$@" <<'PY'
import sys, re
src, dst, *tables = sys.argv[1:]          # tables 一律寫完整的 schema.table
out, skip, hit = [], False, set()
for l in open(src).read().split('\n'):
    m = re.match(r'^COPY (\S+) ', l)
    if m and m.group(1) in tables: skip = True; hit.add(m.group(1))   # 🔴 精確比對：用「結尾是 .profiles」會把 inv.profiles 一起抽掉
    if not skip: out.append(l)
    if skip and l == '\\.': skip = False
missing = set(tables) - hit
if missing: raise SystemExit(f'❌ {src} 裡找不到要抽掉的段：{missing}')
open(dst, 'w').write('\n'.join(out))
PY
}
strip_copy "$SP/dump_ib_data.sql" "$W/ib_data.sql" public.profiles
# 🔴 macOS 的 BSD sed 不支援 \b，原本 sed 's/\bpublic\./…/' 在這台機器會「什麼都不換」→ 快樂手資料靜默灌進小時光的 public 表。
#    改成只改寫 COPY 標頭與 setval 行（資料列裡就算出現 public. 也不會被誤傷）。
rename_schema() { python3 - "$@" <<'PY'
import sys, re
src, dst, new = sys.argv[1:4]
pat = re.compile(r"^(COPY |SELECT pg_catalog\.setval\(')public\.")
n = 0; out = []
for l in open(src).read().split('\n'):
    l2 = pat.sub(lambda m: m.group(1) + new + '.', l); n += (l2 != l); out.append(l2)
open(dst, 'w').write('\n'.join(out)); print(f'  {dst.split("/")[-1]}: {n} 行 public. → {new}.')
PY
}
rename_schema "$W/dump_hh_data.sql" "$W/hh_data.raw.sql" happyhands; strip_copy "$W/hh_data.raw.sql" "$W/hh_data.sql" happyhands.profiles
rename_schema "$W/dump_gd_data.sql" "$W/gd_data.raw.sql" gooddays;   strip_copy "$W/gd_data.raw.sql" "$W/gd_data.sql" gooddays.profiles gooddays._migrations
for f in ib_data hh_data gd_data; do
  { echo "set session_replication_role = replica;"; cat "$W/$f.sql"; } | psql "$NEW_URL" -v ON_ERROR_STOP=1 -q
  echo "  $f 載入"
done

# 4. profiles 回填：只覆蓋 dump 裡有的 id（刪掉那幾列的空殼再 COPY），trigger 替其他站客戶建的空殼保留——
#    這正是「每站都有一列 profile」設計的保證。
fill_profiles() { python3 - "$@" <<'PY'
import sys, re, subprocess
src, sch, URL = sys.argv[1:4]
seg, grab, col = [], False, None
for l in open(src).read().split('\n'):
    m = re.match(r'^COPY ' + re.escape(sch) + r'\.profiles \(([^)]*)\)', l)   # 🔴 精確比對本 schema；第一次排練時抓到 inv.profiles，小時光 8 筆員工 profile 全沒載
    if m: grab = True; col = [c.strip().strip('"') for c in m.group(1).split(',')].index('id')
    if grab: seg.append(l)
    if grab and l == '\\.': break
if not seg: raise SystemExit(f'❌ {src} 裡沒有 COPY {sch}.profiles 段')
ids = [l.split('\t')[col] for l in seg[1:-1] if l]
sql = "set session_replication_role = replica;\ndelete from %s.profiles where id = any(array[%s]::uuid[]);\n%s\n" % (sch, ','.join(f"'{i}'" for i in ids), '\n'.join(seg))
subprocess.run(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-q'], input=sql, text=True, check=True)
n = subprocess.run(['psql', URL, '-Atc', f'select count(*) from {sch}.profiles'], capture_output=True, text=True).stdout.strip()
print(f'  {sch}.profiles: 覆蓋 {len(ids)} 列，表內共 {n} 列（期望 46：每個帳號一列）')
PY
}
fill_profiles "$SP/dump_ib_data.sql" public     "$NEW_URL"
fill_profiles "$W/hh_data.raw.sql"    happyhands "$NEW_URL"
fill_profiles "$W/gd_data.raw.sql"    gooddays   "$NEW_URL"

# 5. dump 帶的 setval 已隨資料載入；印關鍵列數給 70 第 9 段比對
psql "$NEW_URL" -Atc "select 'auth.users '||(select count(*) from auth.users)||' | public.orders '||(select count(*) from public.orders)||' | inv.purchases '||(select count(*) from inv.purchases)||' | hh.orders '||(select count(*) from happyhands.orders)||' | gd.orders '||(select count(*) from gooddays.orders)"
echo "期望 46 | 10 | 1029 | 38 | 2"
