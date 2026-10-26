/**
 * 簽到表 CSV 的欄位定義與檔名規則。
 *
 * ── 為什麼抽成一個檔案而不是寫在 server fn 裡 ─────────────────────────────
 * 快樂手把這一段從 route.ts 抽出來的理由是「Next 的 route handler 只 export 得了
 * GET/POST，欄位定義留在裡面就沒有辦法單獨測它」。小時光的 CSV 是 server fn，
 * 沒有那個限制，但抽出來的理由更強一層：
 *
 *   **selftest 直接 import 這個檔案**，所以它驗到的是 production 真正用的那一份，
 *   不是一份長得很像的複本。CSV injection 這種東西的失效方式就是「測試裡那份是對
 *   的、線上那份沒改到」。
 *
 * ⚠️ 純函式，沒有 server-only：這個檔案不碰資料庫，只把已經取出來的列排成欄位。
 *    型別是 type-only import（編譯後整行消失），所以它不會把 server 端的模組
 *    圖拉進 client bundle。
 *
 * ⚠️ 這份資料是**明文**。它的來源只有一個：repos/event-registrations.ts 的
 *    loadRosterExport()（業主 2026-10-26 起不寫查閱紀錄）。這個檔案本身不做任何授權，
 *    也不該做 —— 授權在 fns/event-registrations.ts 的 requireRosterRead()。
 */
import type { CsvColumn } from "@/lib/csv";
import type { RosterExportRow } from "@/server/repos/event-registrations";

/**
 * 台北時間。
 *
 * ⚠️ **不可以用 new Date().getHours() 那一套**（src/lib/admin/format.ts 是那樣寫
 *    的，因為它在瀏覽器裡跑）。CSV 是在 server 上組的，而 Vercel 的 runtime 是
 *    UTC —— 用本地時間會讓「9/12 早上 9 點的場次」在檔名上變成 9/12 凌晨 1 點，
 *    跨日的那幾場甚至會變成前一天。
 */
function formatTaipei(iso: string | null, withTime = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("year")}/${get("month")}/${get("day")}`;
  if (!withTime) return date;
  return `${date} ${get("hour")}:${get("minute")}`;
}

/**
 * 簽到表的欄位。
 *
 * 順序就是現場點名的順序：先看是誰（座位、姓名），再看聯絡得上聯絡不上（電話、
 * Email），最後才是對帳用的（訂單、付款時間、注意事項）。
 */
export const ROSTER_CSV_COLUMNS: CsvColumn<RosterExportRow>[] = [
  { header: "座位", value: (row) => row.seat_no },
  // 姓名是使用者輸入 —— csvCell() 會把 = + - @ 開頭的值前置單引號擋掉公式執行。
  { header: "姓名", value: (row) => row.name },
  // forceText：0912345678 不包成 ="…" 的話 Excel 會當數字吃掉開頭的 0，
  // 客服照著打會打不通。
  { header: "電話", value: (row) => row.phone ?? "", forceText: true },
  { header: "Email", value: (row) => row.email ?? "" },
  // 訂單編號 IB-202600000001 會被 Excel 猜成運算式，同樣強制文字。
  { header: "訂單編號", value: (row) => row.order_no, forceText: true },
  { header: "付款時間", value: (row) => formatTaipei(row.paid_at) },
  // 空白＝這一位沒有同意紀錄（0020 回填的舊訂單就是這樣）。不要寫成「否」——
  // 「沒有紀錄」與「按了不同意」是兩件事，而後者根本送不出訂單。
  { header: "注意事項同意時間", value: (row) => formatTaipei(row.notice_ack_at) },
];

/**
 * CSV 檔名：`小時光報名名單_春日書桌讀書會_20260912.csv`
 *
 * 中文直接留著。檔名由瀏覽器端的 Blob 下載使用（`<a download>` 的屬性），不經過
 * Content-Disposition，所以**不需要** RFC 5987 編碼 —— 那正是「CSV 不做成 HTTP
 * 路由」順手省掉的一件事。
 *
 * 只拿掉在 Windows / macOS 檔名裡真的不合法的那幾個半形字元；全形的「：」是合法
 * 的，保留才看得出原本的場次名。
 */
export function rosterFilename(sessionTitle: string, startsAt: string | null): string {
  const date = formatTaipei(startsAt, false).replace(/\//g, "");
  const title = sessionTitle
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 40);
  return `小時光報名名單_${title || "場次"}_${date || "無日期"}.csv`;
}
