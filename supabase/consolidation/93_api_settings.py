#!/usr/bin/env python3
"""93_api_settings.py — 目標專案的 PostgREST 設定：把 happyhands／gooddays 兩個 schema 曝露出來。

  93_api_settings.py --dst <ref> [--apply]

沒做這一步，快樂手與好日子的前後台就算把 client 設成 `db: { schema: 'happyhands' }` 也讀不到任何東西
（PostgREST 只服務 db_schema 清單裡的 schema，回 404 PGRST106）。

🔴 `db_extra_search_path` 維持 `public, extensions` 不動。改成含 happyhands／gooddays 會讓
   三個 schema 的裸表名互相污染——那正是計畫裡「最陰的失敗模式」：找不到就靜默落到小時光的同名表。
   各站的函式都已經用 `set search_path` 釘死自己的 schema（71 第 3、4 段驗過）。
🔴 `gooddays_private` 不曝露（它只放 is_admin()，維持原本 private 的用意）。
"""
import argparse, json, subprocess, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import token

API = 'https://api.supabase.com/v1'
WANT_SCHEMAS = ['public', 'graphql_public', 'happyhands', 'gooddays']
WANT_EXTRA_PATH = 'public, extensions'


def call(method, path, body=None):
    args = ['curl', '-s', '-w', '\n%{http_code}', '-X', method, f'{API}{path}',
            '-H', f'Authorization: Bearer {token()}']
    if body is not None:
        args += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    r = subprocess.run(args, capture_output=True, text=True, timeout=90)
    nl = r.stdout.rfind('\n')
    return int(r.stdout[nl + 1:] or 0), json.loads(r.stdout[:nl] or '{}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dst', required=True); ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    code, cur = call('GET', f'/projects/{a.dst}/postgrest')
    if code != 200:
        sys.exit(f'❌ 讀不到 PostgREST 設定（HTTP {code}）')
    now = [x.strip() for x in (cur.get('db_schema') or '').split(',') if x.strip()]
    want = now + [s for s in WANT_SCHEMAS if s not in now]          # 保留現有的，只補缺的
    diff = {}
    if want != now:
        diff['db_schema'] = ','.join(want)
    if (cur.get('db_extra_search_path') or '').strip() != WANT_EXTRA_PATH:
        diff['db_extra_search_path'] = WANT_EXTRA_PATH
    print(f"  db_schema           現在 {now} → 應該 {want}")
    print(f"  db_extra_search_path 現在 {cur.get('db_extra_search_path')!r} → 應該 {WANT_EXTRA_PATH!r}")
    if not diff:
        print("✅ 已經一致"); return
    if not a.apply:
        print(f"═══ 有 {len(diff)} 項要改；確認無誤後加 --apply"); return
    code, body = call('PATCH', f'/projects/{a.dst}/postgrest', diff)
    print(f"═══ 寫入 → HTTP {code}")
    if code >= 300:
        sys.exit(json.dumps(body, ensure_ascii=False)[:400])
    code, after = call('GET', f'/projects/{a.dst}/postgrest')
    got = [x.strip() for x in (after.get('db_schema') or '').split(',')]
    ok = got == want and (after.get('db_extra_search_path') or '').strip() == WANT_EXTRA_PATH
    print(f"{'✅' if ok else '❌'} 回讀：db_schema={got}，extra_search_path={after.get('db_extra_search_path')!r}")


if __name__ == '__main__':
    main()
