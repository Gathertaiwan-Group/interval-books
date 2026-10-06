#!/usr/bin/env python3
"""92_auth_settings.py — 目標專案的 Auth 設定（三站合併後是**集團級**的一組設定）。

  92_auth_settings.py --dst <ref> [--smtp-key-file <Resend API key 檔>] [--smtp-from noreply@gathertaiwan.com] [--apply]

預設只印「現況 vs 應該長怎樣」；加 --apply 才寫入。每一項為什麼這樣挑：

- **uri_allow_list**：三站白名單的聯集，**再加上每一站自己的 site_url**。
  🔴 2026-10-07 修：好日子原本的白名單是空的（它只靠 site_url），只取聯集會把好日子整個漏掉，
     它傳的 redirect 會被 GoTrue 判成不合法、退回 site_url，客人就被導到小時光。
- **site_url = 小時光的 /auth/confirm**：這是「某一站沒傳 redirect」時 {{ .RedirectTo }} 的退路。
  設成落地頁而不是首頁，是因為模板會在後面接 ?token_hash=…；接在首頁後面等於一條什麼都不做的連結。
  三站共用 auth，所以就算別站的客人掉到這裡，小時光的 verifyOtp 一樣能幫他把信箱驗證掉。
- **mailer_autoconfirm = false（信箱驗證開啟）**：🔴 好日子原本是 true。小時光與快樂手的
  claim_guest_orders() 都以 email_confirmed_at 當第一道閘，關著等於註冊別人的信箱就能認領訪客訂單。
- **password_min_length**：取三站最嚴的（8）。**mailer_otp_exp = 3600**：模板文案寫「一小時內有效」，明寫才不會說謊。
- **SMTP**：Resend（smtp.resend.com:465，帳號固定是 `resend`，密碼就是 API key）。寄件人「好日子 Good Days」。
  寄件地址必須是**這把 key 的 Resend 帳號裡已驗證**的網域。用的是**集團自己的 Resend 帳號**（team 裡的 key
  叫 `for claude`／`Onboarding`，網域 intervalbooks.tw、happyhands.com.tw 已驗證，mygoodday.com.tw 7/10 加入
  但還沒驗證）。目前暫用 noreply@intervalbooks.tw；mygoodday.com.tw 驗證通過後改成 noreply@mygoodday.com.tw
  （`--smtp-from` 重跑一次）。
  ⚠️ 2026-10-07 曾短暫用過 RealReal／給樂共用的 Resend 帳號（noreply@gathertaiwan.com），那是廠商的網域，已換掉。
- **rate_limit_email_sent = 三站最大值（60/小時）**：三站共用一個額度。沒有自訂 SMTP 時 Supabase 不准改它（401）。
- **信件模板**：auth_email_templates.py。連結一律走 {{ .RedirectTo }}，見那支檔案的說明。
"""
import argparse, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import token
from auth_email_templates import auth_config_fields

API = 'https://api.supabase.com/v1'
SENDER_NAME = '好日子 Good Days'
WRITE_ONLY = {'smtp_pass'}          # GET 拿不回明文，不拿來比對
SMTP_DEPENDENT = {'smtp_sender_name', 'rate_limit_email_sent'}


def call(method, path, body=None, ref=None):
    args = ['curl', '-s', '-w', '\n%{http_code}', '-X', method, f'{API}{path}',
            '-H', f'Authorization: Bearer {token(ref)}']
    if body is not None:
        args += ['-H', 'Content-Type: application/json', '-d', '@-']
    r = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                       capture_output=True, text=True, timeout=120)
    nl = r.stdout.rfind('\n')
    return int(r.stdout[nl + 1:] or 0), json.loads(r.stdout[:nl] or '{}')


def short(v):
    s = repr(v)
    return s if len(s) <= 90 else s[:87] + '…'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dst', required=True)
    ap.add_argument('--src', action='append',
                    default=['kmpwughmwpdzsizrxhms', 'soglfvjtysqqqzbcwwci', 'xptltqokykpmiqwlnasm'])
    ap.add_argument('--site-url', default=None, help='預設：第一個來源（小時光）的 site_url + /auth/confirm')
    ap.add_argument('--smtp-key-file', default=None)
    ap.add_argument('--smtp-from', default='noreply@intervalbooks.tw')
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()

    srcs = {}
    for ref in a.src:
        code, cfg = call('GET', f'/projects/{ref}/config/auth', ref=ref)
        if code != 200:
            sys.exit(f'❌ 讀不到 {ref} 的 auth 設定（HTTP {code}）')
        srcs[ref] = cfg

    allow = []
    def add(u):
        u = u.strip()
        if u and u not in allow:
            allow.append(u)
    for cfg in srcs.values():
        for u in (cfg.get('uri_allow_list') or '').split(','):
            add(u)
        su = (cfg.get('site_url') or '').rstrip('/')
        if su.startswith('https://'):
            add(su + '/**')                      # 🔴 好日子只有 site_url、白名單是空的
    base = (srcs[a.src[0]].get('site_url') or '').rstrip('/')

    want = {
        'uri_allow_list': ','.join(allow),
        'site_url': a.site_url or f'{base}/auth/confirm',
        'mailer_autoconfirm': False,
        'password_min_length': max(int(c.get('password_min_length') or 6) for c in srcs.values()),
        'mailer_otp_exp': 3600,
        'external_email_enabled': True,
        'disable_signup': False,
        'rate_limit_email_sent': max(int(c.get('rate_limit_email_sent') or 0) for c in srcs.values()),
        'smtp_sender_name': SENDER_NAME,
        **auth_config_fields(),
    }
    if a.smtp_key_file:
        want.update({
            'smtp_host': 'smtp.resend.com', 'smtp_port': '465', 'smtp_user': 'resend',
            'smtp_admin_email': a.smtp_from,
            # smtp_max_frequency（同一人兩封信的最短間隔）維持預設 60 秒，那是防有人狂按「重寄」的保護，不要調低
            'smtp_pass': open(a.smtp_key_file).read().strip(),
        })

    code, cur = call('GET', f'/projects/{a.dst}/config/auth', ref=a.dst)
    if code != 200:
        sys.exit(f'❌ 讀不到目標 {a.dst} 的 auth 設定（HTTP {code}）')
    has_smtp = bool(cur.get('smtp_host') and cur.get('smtp_user') and cur.get('smtp_admin_email')) or bool(a.smtp_key_file)

    print(f'═══ 目標 {a.dst} 的 Auth 設定')
    diff = {}
    for k, v in want.items():
        now = cur.get(k)
        if k in WRITE_ONLY:
            diff[k] = v
            print(f'  → {k} = （寫入；只能寫不能讀回，不比對）')
            continue
        if str(now) == str(v):
            print(f'  ✅ {k}' if k.startswith('mailer_templates') else f'  ✅ {k} = {short(v)}')
        else:
            diff[k] = v
            print(f'  → {k}' + ('（模板內容更新）' if k.startswith('mailer_templates') else f'\n      現在 {short(now)}\n      應該 {short(v)}'))

    now_diff = {k: v for k, v in diff.items() if k not in SMTP_DEPENDENT or has_smtp}
    later = {k: v for k, v in diff.items() if k in SMTP_DEPENDENT and not has_smtp}
    if not [k for k in diff if k not in WRITE_ONLY]:
        print('═══ 已經一致' + ('（只重送 smtp_pass）' if 'smtp_pass' in diff else ''))
    if not a.apply:
        print(f'═══ 有 {len(diff)} 項要寫；確認無誤後加 --apply'); return
    if now_diff:
        code, body = call('PATCH', f'/projects/{a.dst}/config/auth', now_diff, ref=a.dst)
        print(f'═══ 寫入 {len(now_diff)} 項 → HTTP {code}')
        if code >= 300:
            sys.exit(json.dumps(body, ensure_ascii=False)[:400])
        code, after = call('GET', f'/projects/{a.dst}/config/auth', ref=a.dst)
        bad = [k for k, v in now_diff.items() if k not in WRITE_ONLY and str(after.get(k)) != str(v)]
        print('  ✅ 回讀全部相符' if not bad else f'  ❌ 回讀不符：{bad}')
    if later:
        print(f'═══ 還沒套用（要先設好自訂 SMTP）：{sorted(later)}')


if __name__ == '__main__':
    main()
