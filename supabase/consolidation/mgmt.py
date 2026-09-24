"""mgmt.py — Supabase Management API 的 SQL 查詢 helper（單一交易、只讀 token 檔、用 curl 不用 requests：Cloudflare 1010）。"""
import json, os, subprocess, time

SP = os.environ.get('SP', '/private/tmp/claude-501/-Users-aimand--gemini-File/dad55a43-d978-488c-bb46-f3353af97feb/scratchpad')


class ApiError(Exception):
    pass


def token(ref=None):
    """解析該專案要用哪一組 Management token。

    合併的來源與目標可能在**不同的 Supabase 帳號／組織**下（來源三站在 lqtech2026's Org，
    目標可能建在另一個帳號），所以 token 要按專案 ref 決定，不能只有一組。
    `scratchpad/supabase_tokens.tsv` 每行 `<ref 或 *>\t<token 檔名>`；找不到就退回
    `supabase_mgmt_token`。token 只從檔案讀，不寫進腳本、不印出來。
    """
    m = os.path.join(SP, 'supabase_tokens.tsv')
    if os.path.exists(m):
        default = None
        for line in open(m):
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            key, _, fname = line.partition('\t')
            key, fname = key.strip(), fname.strip()
            if not fname:
                continue
            if key == ref:
                return open(os.path.join(SP, fname)).read().strip()
            if key == '*':
                default = fname
        if default:
            return open(os.path.join(SP, default)).read().strip()
    return open(os.path.join(SP, 'supabase_mgmt_token')).read().strip()


def query(ref, sql, timeout=170, retries=3):
    """跑 SQL，回傳最後一個 statement 的列（list of dict）。SQL 錯誤丟 ApiError；連線／限流錯誤重試。"""
    for attempt in range(retries + 1):
        r = subprocess.run(
            ['curl', '-s', '--max-time', str(timeout), '-X', 'POST',
             f'https://api.supabase.com/v1/projects/{ref}/database/query',
             '-H', f'Authorization: Bearer {token(ref)}', '-H', 'Content-Type: application/json', '-d', '@-'],
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
