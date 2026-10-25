/**
 * 這個網址是不是後台（/admin 與 /admin/...）。root loader 用它決定要不要查前台的站台文案。
 * 刻意只認 /admin 這一段完整的路徑段：/administration 之類的前台網址（目前沒有，但將來可能有）
 * 不可以被當成後台而拿到預設文案。零 import，selftest 直接 import()。
 */
export function isBackOfficePath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}
