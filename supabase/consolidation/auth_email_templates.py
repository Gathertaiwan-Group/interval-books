"""auth_email_templates.py — 三站合併後共用的一組 Supabase Auth 信件模板（主旨＋HTML）。

由 92_auth_settings.py 讀取並寫進目標專案。改文案改這裡，再跑一次 92 --apply。

🔴 連結一律用 `{{ .RedirectTo }}`，絕對不要用 `{{ .SiteURL }}`：
   合併後三站共用一組模板，SiteURL 只有一個值。快樂手原本的模板寫死 `{{ .SiteURL }}/auth/confirm`，
   照搬的話快樂手客人的驗證連結會被導到小時光的網站。RedirectTo 是每一站呼叫 signUp／
   resetPasswordForEmail 時自己傳的網址，而且 GoTrue 會先拿它比對 uri_allow_list，不在白名單就退回
   site_url——所以它同時是「回到對的那一站」與「不會被拿去釣魚」的那個值。

🔴 契約：每一站傳的 redirect 必須**剛好是** `<該站網域>/auth/confirm`，不能帶 query string，
   因為模板會直接接 `?token_hash=…`。三站的 /auth/confirm 都吃 token_hash＋type（小時光只認
   signup／recovery、依 type 自己決定導向；快樂手與好日子還會讀 next）。
   沒傳 redirect 的退路是 site_url，所以 site_url 設成小時光的 /auth/confirm（見 92）。

為什麼走 token_hash 而不是預設的 {{ .ConfirmationURL }}：預設連結會繞到 <ref>.supabase.co，
網址列出現陌生網域會讓長輩以為是詐騙信；而且它把 session 放在網址 # 後面，伺服器端的落地頁讀不到。
token_hash 由各站伺服器直接 verifyOtp，用哪一台瀏覽器打開都可以。
"""

BRAND = "好日子 Good Days"
SHOPS = "小時光書店・快樂手・好日子　三個網站共用同一個帳號"


def link(kind: str, nxt: str) -> str:
    return "{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=" + kind + "&next=" + nxt


def layout(title: str, body_html: str, action_html: str = "") -> str:
    return f"""<!doctype html>
<html lang="zh-Hant">
<body style="margin:0;padding:0;background:#F6F2EA;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F2EA;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E7DDCB;border-radius:16px;">
        <tr><td style="padding:32px 28px;">
          <p style="margin:0 0 2px;font-size:13px;letter-spacing:.14em;color:#8A6E4B;">GOOD DAYS 好日子</p>
          <p style="margin:0 0 20px;font-size:12px;line-height:1.7;color:#9B8B76;">{SHOPS}</p>
          <h1 style="margin:0 0 18px;font-size:22px;line-height:1.5;color:#2F2A24;font-weight:600;">{title}</h1>
          {body_html}
          {action_html}
        </td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:13px;line-height:1.8;color:#8A7B66;">
        好日子股份有限公司<br>
        這封信由系統自動寄出，請不要直接回覆。
      </p>
    </td></tr>
  </table>
</body>
</html>"""


def para(text: str) -> str:
    return f'<p style="margin:0 0 18px;font-size:16px;line-height:1.9;color:#2F2A24;">{text}</p>'


def button(href: str, label: str) -> str:
    return (f'<a href="{href}" style="display:inline-block;background:#6B5A45;color:#FFFFFF;text-decoration:none;'
            f'padding:14px 28px;border-radius:999px;font-size:17px;">{label}</a>'
            f'<p style="margin:22px 0 0;font-size:14px;line-height:1.9;color:#7A6B57;">按鈕沒有反應的話，'
            f'把下面這串網址複製到瀏覽器的網址列：<br><span style="word-break:break-all;color:#8A6E4B;">{href}</span></p>')


def note(text: str) -> str:
    return f'<p style="margin:18px 0 0;font-size:14px;line-height:1.9;color:#7A6B57;">{text}</p>'


IGNORE = note("如果你沒有做過這件事，直接忽略這封信就好，不會有任何事情發生。")
EXPIRES = "連結只能用一次，一小時內有效。"

TEMPLATES = {
    "confirmation": (
        "【好日子】請確認你的信箱",
        layout("確認一下你的信箱",
               para("你剛剛在我們的網站註冊了帳號。按下面的按鈕完成信箱確認，之後就可以登入。"),
               button(link("signup", "/account"), "確認信箱") + note(EXPIRES) + IGNORE),
    ),
    "recovery": (
        "【好日子】重設你的密碼",
        layout("重設密碼",
               para("我們收到重設密碼的請求。按下面的按鈕設定新密碼。"),
               button(link("recovery", "/reset-password"), "設定新密碼") + note(EXPIRES) +
               note("如果不是你本人申請，請忽略這封信，原本的密碼會繼續有效。")),
    ),
    "magic_link": (
        "【好日子】你的登入連結",
        layout("一鍵登入",
               para("按下面的按鈕就能直接登入，不用輸入密碼。"),
               button(link("magiclink", "/account"), "登入") + note(EXPIRES) + IGNORE),
    ),
    "invite": (
        "【好日子】你收到一份邀請",
        layout("你收到一份邀請",
               para("有人邀請你使用我們的網站。按下面的按鈕接受邀請，並設定你的帳號。"),
               button(link("invite", "/account"), "接受邀請") + note(EXPIRES) + IGNORE),
    ),
    "email_change": (
        "【好日子】確認更換登入信箱",
        layout("確認更換登入信箱",
               para("你申請把登入信箱改成 <strong>{{ .NewEmail }}</strong>。按下面的按鈕確認。"),
               button(link("email_change", "/account/settings"), "確認更換") + note(EXPIRES) +
               note("如果不是你本人操作，請忽略這封信，原本的信箱會繼續有效。")),
    ),
    "reauthentication": (
        "【好日子】你的驗證碼：{{ .Token }}",
        layout("你的驗證碼",
               para("請在網站上輸入下面這組驗證碼，完成身分確認。"),
               '<p style="margin:0 0 18px;font-size:30px;letter-spacing:.3em;font-weight:600;color:#2F2A24;">{{ .Token }}</p>'
               + note("驗證碼一小時內有效。") + IGNORE),
    ),
}


def auth_config_fields() -> dict:
    """轉成 Management API PATCH /config/auth 的欄位。"""
    out = {}
    for kind, (subject, html) in TEMPLATES.items():
        out[f"mailer_subjects_{kind}"] = subject
        out[f"mailer_templates_{kind}_content"] = html
    return out


if __name__ == "__main__":
    import re
    for kind, (subject, html) in TEMPLATES.items():
        assert "{{ .SiteURL }}" not in html, kind
        if kind != "reauthentication":
            assert "{{ .RedirectTo }}?token_hash={{ .TokenHash }}" in html, kind
        hrefs = re.findall(r'href="([^"]+)"', html)
        print(f"{kind:<17} 主旨={subject}\n{'':<17} 連結={hrefs}")
