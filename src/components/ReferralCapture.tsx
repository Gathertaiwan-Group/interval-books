/**
 * 任何頁面帶 `?ref=CODE` → 寫進第一方 cookie `ib_ref`（30 天，最後一次點的連結蓋掉
 * 前一次）。結帳頁會用它預填推薦碼欄位。
 *
 * 刻意在瀏覽器端寫，不在伺服器端 Set-Cookie：公開頁面是可以被 CDN 快取的
 * （src/server/cache-policy.ts），伺服器回應帶 Set-Cookie 會被快取或剝掉。
 * 這裡不驗證碼存不存在（那要打資料庫），只擋格式；結帳時才查。
 *
 * 不渲染任何東西，也不改網址（保留 ?ref= 讓分享出去的連結維持原樣）。
 */
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { referralCodeFromSearch, referralCookieString } from "@/lib/referral";

export function ReferralCapture() {
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const code = referralCodeFromSearch(window.location.search || searchStr || "");
    if (!code) return;
    try {
      document.cookie = referralCookieString(code, {
        secure: window.location.protocol === "https:",
      });
    } catch {
      // cookie 被封鎖：客人還是可以在結帳時自己打碼。
    }
  }, [searchStr]);
  return null;
}
