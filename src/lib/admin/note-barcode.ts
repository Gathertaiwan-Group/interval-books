/**
 * 「條碼寫在備註裡」的比對規則 —— 櫃檯掃碼與後台商品搜尋共用。
 *
 * ── 為什麼需要這支 ────────────────────────────────────────────────────────
 * 正式庫 inv.products 993 筆裡，barcode 欄只有 27 筆有值；另外約 723 筆的條碼是舊系統匯入時
 * 寫進 notes 的，長這樣（2026-11-08 唯讀盤點）：
 *
 *     條碼: 636864\n系列: 2024.08
 *     條碼: 9789861234567\n系列: …\n出版: …
 *
 * 舊系統（小時光書店進銷存/src/components/sales/QuickSaleScanner.tsx）掃碼時先比 barcode、
 * 找不到再比 `notes.includes("條碼: " + code)`。新櫃檯只比 barcode，所以那 723 筆掃不到。
 *
 * ── 兩段式比對，第二段才是準的 ────────────────────────────────────────────
 *   1. 資料庫端粗篩：`notes ILIKE '%條碼%<code>%'`（code 先轉義 \ % _）。這只是縮小範圍，
 *      `條碼: 1636864` 或 `條碼: 111\n系列: 636864` 都會被撈到。
 *   2. 程式端精篩：從備註裡解析出「條碼」後面那一個 token，**整個 token 等於掃到的碼**才算。
 *      部分數字（636864 vs 6368641）不會誤中。
 *
 * 容忍的變體：半形／全形冒號、沒有冒號、冒號前後有無空白（含換行）、全形數字（NFKC 正規化）、
 * token 尾巴的標點（「636864。」）。
 *
 * 已知抓不到的：被 Excel 轉成科學記號的條碼（正式庫有 2 筆像 `9.78986E+12`），那串數字已經
 * 不是原本的條碼了，只能改資料。
 *
 * 純函式、零 import：scripts/note-barcode-selftest.mjs 直接 import()。
 */

/** 掃到／打進來的條碼只接受英數，最長 64（與 fns/pos.ts 的 validator 同一個上限）。 */
const SAFE_CODE = /^[0-9A-Za-z]{1,64}$/;

/**
 * trim + NFKC（全形英數 → 半形），不是純英數就回 null。
 *
 * 回 null 的輸入**不會**拿去組 ILIKE —— 這是萬用字元注入的第一道防線（第二道是 escapeLikePattern）。
 */
export function normalizeScannedCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.normalize("NFKC").trim();
  return SAFE_CODE.test(code) ? code : null;
}

/** LIKE／ILIKE 的萬用字元轉義：\ → \\、% → \%、_ → \_（Postgres 預設跳脫字元就是 \）。 */
export function escapeLikePattern(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 資料庫端粗篩用的 ILIKE pattern。code 必須先過 normalizeScannedCode。 */
export function noteBarcodeIlikePattern(code: string): string {
  return `%條碼%${escapeLikePattern(code)}%`;
}

/**
 * 「條碼」後面接（可有可無的）冒號與空白，再接一個 token。
 * token 遇到空白、換行或常見分隔符號就結束。
 */
const NOTE_BARCODE_RE = /條碼\s*[:：]?\s*([^\s,，;；、|/]+)/gu;

/** 從備註解析出所有「條碼」token（通常 0 或 1 個）。 */
export function extractNoteBarcodes(notes: unknown): string[] {
  if (typeof notes !== "string" || notes === "") return [];
  const text = notes.normalize("NFKC");
  const out: string[] = [];
  for (const m of text.matchAll(NOTE_BARCODE_RE)) {
    // 尾巴的標點不算條碼的一部分（「條碼: 636864。」）；中間的不動（科學記號那種就讓它對不上）。
    const token = m[1].replace(/[^0-9A-Za-z]+$/u, "");
    if (token) out.push(token);
  }
  return out;
}

/** 備註裡解析出的某一個條碼**完全等於** code（英文字母不分大小寫）。 */
export function noteHasBarcode(notes: unknown, code: string): boolean {
  const want = code.toUpperCase();
  return extractNoteBarcodes(notes).some((t) => t.toUpperCase() === want);
}

export type NoteCandidate = { inv_product_id: string; notes: string | null };

/** 粗篩的上限。6 位數的碼「部分包含」的列很少，100 綽綽有餘；超過也只是多比幾列。 */
export const NOTE_CANDIDATE_LIMIT = 100;

/**
 * 兩段式比對的完整流程。資料庫存取由呼叫端注入（repo 用 supabaseAdmin，selftest 用假資料或
 * 唯讀的正式庫），所以這裡保持純粹、可測。
 *
 * 回傳命中的 inv_product_id（保持 fetchCandidates 回來的順序）。輸入不合法 → 空陣列，**不打資料庫**。
 */
export async function findIdsByNoteBarcode(
  rawCode: unknown,
  fetchCandidates: (ilikePattern: string, limit: number) => Promise<NoteCandidate[]>,
): Promise<string[]> {
  const code = normalizeScannedCode(rawCode);
  if (!code) return [];
  const rows = await fetchCandidates(noteBarcodeIlikePattern(code), NOTE_CANDIDATE_LIMIT);
  return rows.filter((r) => noteHasBarcode(r.notes, code)).map((r) => r.inv_product_id);
}
