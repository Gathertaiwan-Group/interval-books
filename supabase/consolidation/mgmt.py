"""mgmt.py — Supabase Management API 的 SQL 查詢 helper（單一交易、只讀 token 檔、用 curl 不用 requests：Cloudflare 1010）。"""
import json, os, subprocess, time

SP = os.environ.get('SP', '/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad')


class ApiError(Exception):
    pass


def token():
    return open(os.path.join(SP, 'supabase_mgmt_token')).read().strip()


def query(ref, sql, timeout=170, retries=3):
    """跑 SQL，回傳最後一個 statement 的列（list of dict）。SQL 錯誤丟 ApiError；連線／限流錯誤重試。"""
    for attempt in range(retries + 1):
        r = subprocess.run(
            ['curl', '-s', '--max-time', str(timeout), '-X', 'POST',
             f'https://api.supabase.com/v1/projects/{ref}/database/query',
             '-H', f'Authorization: Bearer {token()}', '-H', 'Content-Type: application/json', '-d', '@-'],
            input=json.dumps({'query': sql}), capture_output=True, text=True, timeout=timeout + 15)
        try:
            d = json.loads(r.stdout)
        except Exception:
            if attempt < retries:
                time.sleep(3 * (attempt + 1)); continue
            raise ApiError(f'non-JSON reply rc={r.returncode}: {r.stdout[:300]} {r.stderr[:200]}')
        if isinstance(d, dict) and 'message' in d:
            msg = str(d['message'])
            if attempt < retries and ('rate' in msg.lower() or 'too many' in msg.lower() or '502' in msg or '504' in msg):
                time.sleep(5 * (attempt + 1)); continue
            raise ApiError(msg[:1000])
        return d
    raise ApiError('unreachable')


def sql_str(s):
    """Python 字串 → SQL 字面值。"""
    return "'" + s.replace("'", "''") + "'"


def in_list(names):
    return '(' + ','.join(sql_str(n) for n in names) + ')'
