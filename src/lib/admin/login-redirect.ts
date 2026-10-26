/**
 * 登入後要回到哪裡（?redirect=）。**只收 /oauth/authorize** —— 那是 MCP 連接器的授權頁，
 * 老闆從 Claude 被帶過來時還沒登入。其他任何值一律忽略（不做通用的 return-to：那就是一個
 * open redirect，而這一頁每一個人都看得到）。
 */
export function safeLoginRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8000) return undefined;
  if (!value.startsWith("/oauth/authorize")) return undefined;
  const rest = value.slice("/oauth/authorize".length);
  if (rest !== "" && !rest.startsWith("?")) return undefined;
  if (/[\\\s]/.test(value)) return undefined;
  return value;
}
