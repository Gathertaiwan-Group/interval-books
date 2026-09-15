#!/usr/bin/env python3
"""92_auth_settings.py — 目標專案的 Auth 設定（Phase 2）：三站合併後 Auth 是**集團級**的一組設定。

  92_auth_settings.py --dst <ref> [--src <ref> ...] [--apply] [--site-url URL]

預設只印「現況 vs 應該長怎樣」；加 --apply 才寫入。

合併後只有一組設定，所以每一項都要挑：
- **uri_allow_list**：三站聯集（少一條 = 那一站的驗證信連結被拒）。
- **mailer_autoconfirm = false（信箱驗證開啟）**：🔴 好日子現在是 true。小時光 `claim_guest_orders()`
  與快樂手同名函式都以 `email_confirmed_at is not null` 當第一道閘——關著等於任何人註冊別人的信箱
  就能認領訪客訂單。合併後一律開；好日子既有的 2 個帳號要手動標成 confirmed。
- **password_min_length**：取三站最嚴的（8；好日子現在是 6，既有密碼不會被重新驗證）。
- **rate_limit_email_sent**：三站共用一個額度，取最大值（60/小時）當起點，切換後看實際用量。
- **smtp_sender_name = 好日子 Good Days**（使用者定案）。
🔴 **SMTP 密碼搬不了**（Supabase 存的是雜湊），host／user／pass 要在 Dashboard 手動填一次；
   寄件地址也必須是 Resend 上已驗證的網域，這支腳本不會亂動 smtp_host／smtp_user／smtp_pass。
"""
import argparse, json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mgmt import token

API = 'https://api.supabase.com/v1'
SENDER_NAME = '好日子 Good Days'


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
    ap.add_argument('--dst', required=True)
    ap.add_argument('--src', action='append', default=['kmpwughmwpdzsizrxhms', 'soglfvjtysqqqzbcwwci', 'xptltqokykpmiqwlnasm'])
    ap.add_argument('--site-url', default=None, help='預設用小時光的正式網域（第一個切換、也是唯一有穩定自訂網域的）')
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()

    srcs = {}
    for ref in a.src:
        code, cfg = call('GET', f'/projects/{ref}/config/auth')
        if code != 200:
            sys.exit(f'❌ 讀不到 {ref} 的 auth 設定（HTTP {code}）')
        srcs[ref] = cfg

    allow = []
    for cfg in srcs.values():
        for u in (cfg.get('uri_allow_list') or '').split(','):
            u = u.strip()
            if u and u not in allow:
                allow.append(u)
    # 🔴 Supabase 的限制：沒有自訂 SMTP 之前，smtp_sender_name 與 rate_limit_email_sent 改不了
    #    （HTTP 401 "Custom SMTP required…"），而且 PATCH 是全有全無——混在一起送會整批失敗。
    #    所以拆兩組：SMTP 無關的先套，SMTP 相關的等 Dashboard 把 host／user／pass 填好再套。
    SMTP_DEPENDENT = {'smtp_sender_name', 'rate_limit_email_sent'}
    want = {
        'uri_allow_list': ','.join(allow),
        'site_url': a.site_url or srcs[a.src[0]].get('site_url'),
        'mailer_autoconfirm': False,
        'password_min_length': max(int(c.get('password_min_length') or 6) for c in srcs.values()),
        'rate_limit_email_sent': max(int(c.get('rate_limit_email_sent') or 0) for c in srcs.values()),
        'smtp_sender_name': SENDER_NAME,
        'external_email_enabled': True,
        'disable_signup': False,
    }

    code, cur = call('GET', f'/projects/{a.dst}/config/auth')
    if code != 200:
        sys.exit(f'❌ 讀不到目標 {a.dst} 的 auth 設定（HTTP {code}）')
    print(f"═══ 目標 {a.dst} 的 Auth 設定")
    diff = {}
    for k, v in want.items():
        now = cur.get(k)
        same = (str(now) == str(v))
        if not same:
            diff[k] = v
        mark = '✅' if same else '→'
        print(f"  {mark} {k}\n      現在 {now!r}\n      應該 {v!r}" if not same else f"  ✅ {k} = {v!r}")

    has_smtp = bool(cur.get('smtp_host') and cur.get('smtp_user') and cur.get('smtp_admin_email'))
    now_diff = {k: v for k, v in diff.items() if k not in SMTP_DEPENDENT or has_smtp}
    later = {k: v for k, v in diff.items() if k in SMTP_DEPENDENT and not has_smtp}

    if not diff:
        print("═══ 已經一致，不用改")
    elif not a.apply:
        print(f"═══ 有 {len(diff)} 項要改；確認無誤後加 --apply")
        if later:
            print(f"   （其中 {sorted(later)} 要等自訂 SMTP 設好才改得動）")
    else:
        if now_diff:
            code, body = call('PATCH', f'/projects/{a.dst}/config/auth', now_diff)
            print(f"═══ 寫入 {sorted(now_diff)} → HTTP {code}")
            if code >= 300:
                sys.exit(json.dumps(body, ensure_ascii=False)[:400])
            code, after = call('GET', f'/projects/{a.dst}/config/auth')
            bad = [k for k, v in now_diff.items() if str(after.get(k)) != str(v)]
            print("  ✅ 回讀全部相符" if not bad else f"  ❌ 回讀不符：{bad}")
        if later:
            print(f"═══ 還沒套用（要先在 Dashboard 設好自訂 SMTP）：{json.dumps(later, ensure_ascii=False)}")
            print("   設好之後再跑一次這支腳本就會補上。")

    print("\n═══ 這支腳本不會動、必須手動處理的：")
    print("  1. SMTP host／user／pass：Supabase 存的是雜湊，搬不過來，要在 Dashboard 重填一次")
    print(f"     （小時光現用 {srcs[a.src[0]].get('smtp_host')}，寄件地址 {srcs[a.src[0]].get('smtp_admin_email')}；"
          f"寄件地址必須是 Resend 上已驗證的網域）")
    print("  2. 好日子既有的 2 個帳號：原本 autoconfirm=true 進來的，要手動補 email_confirmed_at")
    print("  3. 郵件模板：三站各自有一整組，合併後只有一組，內容要中性化（風險 2）")


if __name__ == '__main__':
    main()
