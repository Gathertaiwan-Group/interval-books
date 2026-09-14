#!/usr/bin/env python3
"""用 Supabase Management API 對某個專案逐段跑 SQL 檔（每段一個交易）。
段落以 `-- ===== <name> =====` 分隔；第一段是檔首。遇錯即停、印出段名與錯誤。
用法：run_sql.py <ref> <file.sql> [--var k=v ...]   （--var 會把 :'k' 換成字面值）
Token 讀 scratchpad/supabase_mgmt_token。"""
import sys, re, json, subprocess, os, argparse
ap = argparse.ArgumentParser(); ap.add_argument('ref'); ap.add_argument('file'); ap.add_argument('--var', action='append', default=[]); ap.add_argument('--search-path', dest='sp', default=None, help='每段前綴 set local search_path = <sp>, public（裸表名落到對的 schema）')
ap.add_argument('--from', dest='frm', type=int, default=1, help='從第 N 段開始（重跑失敗段用）')
a = ap.parse_args()
SP = os.environ.get('SP', '/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad')
tok = open(os.path.join(SP, 'supabase_mgmt_token')).read().strip()
src = open(a.file, encoding='utf-8').read()
for kv in a.var:
    k, v = kv.split('=', 1); src = src.replace(f":'{k}'", f"'{v}'")
parts = re.split(r'^-- ===== (.*?) =====\s*$', src, flags=re.M)
segs = [('(檔首)', parts[0])] + [(parts[i], parts[i+1]) for i in range(1, len(parts), 2)]
ok = 0
for i, (name, body) in enumerate(segs, 1):
    if i < a.frm or not body.strip(): continue
    if a.sp: body = f'set local search_path = {a.sp}, public;\n' + body
    payload = json.dumps({'query': body})
    r = subprocess.run(['curl', '-s', '--max-time', '180', '-X', 'POST', f'https://api.supabase.com/v1/projects/{a.ref}/database/query',
                        '-H', f'Authorization: Bearer {tok}', '-H', 'Content-Type: application/json', '-d', payload],
                       capture_output=True, text=True, timeout=200)
    try: d = json.loads(r.stdout)
    except Exception: d = {'message': f'non-JSON: {r.stdout[:200]}'}
    if isinstance(d, dict) and 'message' in d:
        print(f'  ❌ [{i}/{len(segs)}] {name}\n     {d["message"][:600]}'); sys.exit(1)
    ok += 1
    tail = f' → {json.dumps(d, ensure_ascii=False)[:160]}' if isinstance(d, list) and d else ''
    print(f'  ✅ [{i}/{len(segs)}] {name}{tail}')
print(f'全部 {ok} 段成功')
