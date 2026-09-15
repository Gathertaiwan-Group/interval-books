#!/usr/bin/env bash
# schema_diff.sh <來源 ref> <目標 ref> [schema ...]
#   兩邊各跑一次 api_ddl.py 再 diff——schema 忠實度的證據（表／欄位／default／約束／索引／view／函式／trigger／
#   policy／表級與欄位級 ACL／comment／RLS／序列參數全部逐字比對）。
#
# 目標上會有「刻意多出來」的物件：40 建的 public.interval_on_auth_user_created()（三站扇出的小時光那一支）。
# IGNORE_RE 指定要略過的物件名；略過的是**整個區塊**（含函式本體與它的 GRANT／REVOKE），不是單行，
# 所以只要該物件以外有任何一個字不同就會失敗。IGNORE_RE='' 可要求完全一致。
set -euo pipefail
src=$1; dst=$2; shift 2; schemas=("${@:-public}")
IGNORE_RE=${IGNORE_RE-interval_on_auth_user_created}
here=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d)
args=(); for s in "${schemas[@]}"; do args+=(--schema "$s"); done
python3 "$here/api_ddl.py" --ref "$src" --out "$W/src.sql" "${args[@]}" >/dev/null
python3 "$here/api_ddl.py" --ref "$dst" --out "$W/dst.sql" "${args[@]}" >/dev/null

# 以空行分段（api_ddl.py 每個物件一段），丟掉檔頭與符合 IGNORE_RE 的整段
filter() { python3 - "$1" "$2" "$IGNORE_RE" <<'PY'
import sys, re
src, dst, ig = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src).read()
blocks = [b for b in text.split('\n\n') if not b.startswith('-- Dumped') ]
rx = re.compile(ig) if ig else None
kept, dropped = [], 0
for b in blocks:
    if rx and rx.search(b): dropped += 1; continue
    kept.append(b)
open(dst, 'w').write('\n\n'.join(kept))
print(dropped)
PY
}
d_src=$(filter "$W/src.sql" "$W/src.f"); d_dst=$(filter "$W/dst.sql" "$W/dst.f")
lines=$(grep -c '' "$W/src.f")
if diff "$W/src.f" "$W/dst.f" > "$W/diff.txt"; then
  note=""; [ "$d_dst" != 0 ] && note="（目標另有 $d_dst 個刻意加的 $IGNORE_RE 區塊，已略過；來源 $d_src 個）"
  echo "✅ schema 相同（$lines 行 DDL 逐字一致）$note"; exit 0
fi
echo "❌ 有差異（$(grep -cE '^[<>]' "$W/diff.txt") 行），前 40 行："; head -40 "$W/diff.txt"; echo "完整 diff：$W/diff.txt"; exit 1
