/**
 * 台北時間「YYYY/MM/DD HH:mm」—— SSR 頁面上顯示時間點用這一支。
 *
 * ── 為什麼不能直接 toLocaleString ─────────────────────────────────────────
 * 後台是 SSR 的：同一個字串會被**伺服器**先印一次、**瀏覽器**再印一次，兩次不一樣
 * 就是 React #418（hydration mismatch），React 會丟掉伺服器那一段整棵重畫。
 * toLocaleString 在兩件事上都會讓兩邊不一樣：
 *
 *   1. **時區。** 沒給 timeZone 時讀的是執行環境的時區。Vercel 跑在 UTC，店員的瀏覽器
 *      在台灣，於是伺服器印出晚 8 小時的時間（/admin/events/$id、/admin/registrations
 *      都踩過）。
 *   2. **ICU 版本。** 就算給了 timeZone，輸出的「字」還是各家 ICU 自己決定的。實測
 *      （2026-10-09）`toLocaleString("zh-TW", { hour: "2-digit", … })`：
 *        Node 25.6.1（ICU 78.2）→ "2026/10/09\u2009下午07:05"（日期後面是 THIN SPACE）
 *        Chrome 155              → "2026/10/09 下午07:05"（一般空白）
 *      肉眼看不出差別，React 看得出來 —— /admin/orders 有寫 timeZone 卻還是 #418 就是這個。
 *      「上午／下午」本身也一樣不可靠：CLDR 改過不只一次（下午／晚上／凌晨）。
 *
 * 所以這裡只向 Intl 要**數字**（formatToParts 的 year/month/day/hour/minute），分隔符號
 * 自己拼；24 小時制，沒有「上午／下午」。時區寫死 Asia/Taipei：這是一間台北的書店，
 * 時間屬於店，不屬於看的人（同 src/components/shop/SessionPicker.tsx 的立場）。
 *
 * ⚠️ 不要改回 getHours()／getDate() 那一組 —— 那一組讀的也是執行環境的時區。
 */

const TAIPEI_TIME_ZONE = "Asia/Taipei";

/** en-CA 只是為了拿到 ASCII 數字的 parts；版面完全由下面自己拼，與語系無關。 */
const TAIPEI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: TAIPEI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * timestamptz（或任何 Date 解得開的字串）→ 台北的「2026/10/09 19:05」。
 *
 * - null／undefined／空字串 → 「—」（後台表格「沒有值」的慣例）。
 * - 解不開的字串原樣回傳：畫面上出現一個看得懂的原始值，好過 "Invalid Date"。
 */
export function formatTaipeiDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of TAIPEI_PARTS.formatToParts(d)) p[part.type] = part.value;
  const two = (v: string | undefined) => (v ?? "").padStart(2, "0");
  // 部分 runtime 在午夜給 "24"（同 SessionPicker／blackcat.ts 的註解），正規化回 "00"。
  const hour = p.hour === "24" ? "00" : two(p.hour);
  return `${p.year}/${two(p.month)}/${two(p.day)} ${hour}:${two(p.minute)}`;
}

/** 只要日期：台北的「2026/10/09」。「—」與解不開的字串的規則同 formatTaipeiDateTime。 */
export function formatTaipeiDate(iso: string | null | undefined): string {
  const s = formatTaipeiDateTime(iso);
  return /^\d{4}\/\d{2}\/\d{2} /.test(s) ? s.slice(0, 10) : s;
}
