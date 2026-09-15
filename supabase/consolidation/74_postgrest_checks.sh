#!/usr/bin/env bash
# 74_postgrest_checks.sh <目標 ref> — 用真正的 HTTP 請求驗證「三個 schema 各讀到自己的表」。
#   70／71 是在資料庫裡驗，這支是從外面驗——PostgREST 的 Accept-Profile 走一遍，才算證明 client 端可用。
#   期望：不帶 profile → 小時光 public；Accept-Profile: happyhands → 快樂手；gooddays → 好日子；
#        gooddays_private 不可曝露（PGRST106）。anon key 即時從 Management API 取、不落地。
set -euo pipefail
ref=${1:?用法: 74_postgrest_checks.sh <ref>}
here=$(cd "$(dirname "$0")" && pwd)
tok=$(cat "${SP:-/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad}/supabase_mgmt_token")
anon=$(curl -s -H "Authorization: Bearer $tok" "https://api.supabase.com/v1/projects/$ref/api-keys?reveal=true" \
        | python3 -c 'import json,sys; print(next(k["api_key"] for k in json.load(sys.stdin) if k["id"]=="anon"))')
base="https://$ref.supabase.co/rest/v1"

# 期望值＝「以 anon 身分在資料庫裡查得到幾列」。
# 🔴 不能用整表 count：RLS 會擋掉未上架的商品（快樂手 8 列裡 anon 只看得到 6 列），
#    拿整表數字當期望會把「RLS 正常運作」誤判成錯誤。
read -r ib hh gd < <(python3 "$here/q.py" "$ref" "set local role anon; select (select count(*) from public.products) a, (select count(*) from happyhands.products) b, (select count(*) from gooddays.products) c" --raw \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)[0]; print(d["a"], d["b"], d["c"])')
echo "以 anon 身分在資料庫裡查得到的 products：小時光 $ib／快樂手 $hh／好日子 $gd（整表數字另見 70）"

fail=0
check() { # <說明> <期望列數> <profile|->
  local label=$1 want=$2 prof=$3
  local hdr=(-H "apikey: $anon" -H "Authorization: Bearer $anon")   # set -u 下空陣列展開會報錯，改成一定非空
  [ "$prof" != "-" ] && hdr+=(-H "Accept-Profile: $prof")
  local n
  n=$(curl -s "${hdr[@]}" \
        "$base/products?select=id&limit=1000" | python3 -c 'import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print("ERR:非JSON "+raw[:60]); raise SystemExit
print(len(d) if isinstance(d,list) else "ERR:"+str(d.get("code") or d.get("message"))[:40])')
  if [ "$n" = "$want" ]; then echo "  ✅ $label → $n 列"; else echo "  ❌ $label → $n（期望 $want）"; fail=1; fi
}
echo "═══ 同一個 /products 端點，靠 Accept-Profile 分流"
check "不帶 profile（＝小時光 public）" "$ib" -
check "Accept-Profile: happyhands"      "$hh" happyhands
check "Accept-Profile: gooddays"        "$gd" gooddays

echo "═══ gooddays_private 不可以被曝露"
code=$(curl -s -H "Accept-Profile: gooddays_private" -H "apikey: $anon" -H "Authorization: Bearer $anon" \
        "$base/profiles?select=id&limit=1" | python3 -c 'import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print("非JSON:"+raw[:60]); raise SystemExit
print(d.get("code","(回了資料)") if isinstance(d,dict) else "(回了資料)")')
if [ "$code" = "PGRST106" ]; then echo "  ✅ 擋下來了（$code）"; else echo "  ❌ 竟然可以存取（$code）"; fail=1; fi

echo "═══ RLS 仍然有效：anon 不可以讀好日子的點數餘額 view"
code=$(curl -s -H "Accept-Profile: gooddays" -H "apikey: $anon" -H "Authorization: Bearer $anon" \
        "$base/v_user_points_balance?select=*&limit=1" | python3 -c 'import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print("非JSON:"+raw[:60]); raise SystemExit
print(d.get("code","(回了資料)") if isinstance(d,dict) else "(回了資料)")')
if [ "$code" = "42501" ] || [ "$code" = "PGRST205" ]; then echo "  ✅ 擋下來了（$code）"; else echo "  ❌ 竟然讀得到（$code）"; fail=1; fi

[ $fail = 0 ] && echo "✅ PostgREST 分流與權限都正確" || { echo "❌ 有項目不符"; exit 1; }
