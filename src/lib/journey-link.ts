/**
 * 策旅卡片「前往策旅」連結的 href/target 規則——首頁精選（index.tsx）與 /journeys
 * 列表（journeys.tsx）共用，兩處必須一致。
 *
 * `external_url` 一欄同時承載兩種策旅（見 admin/schemas.ts 的 registrationFields）：
 *   - 站內報名的策旅存相對路徑（如 `/events/xxx`）→ 同分頁導航，不開新視窗
 *   - 有獨立外部網站的策旅存完整網址（`https://…`）→ 新分頁開啟
 *   - 空字串（還沒設）→ 回 null，呼叫端不要渲染連結，而不是連到空白
 */
export function journeyLinkProps(
  url: string | null | undefined,
  /** 站內路徑加上目前網址的語言前綴（/en、/ja）；元件裡傳 useLocalizeHref() 的結果。 */
  localize: (href: string) => string = (href) => href,
): { href: string; target?: "_blank"; rel?: "noreferrer" } | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/")) return { href: localize(trimmed) };
  return { href: trimmed, target: "_blank", rel: "noreferrer" };
}
