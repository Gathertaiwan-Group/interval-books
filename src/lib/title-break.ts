/**
 * 標題在第一個逗號／頓號之後換行（2026-11-10 /events 頁首：390 寬時「在書店相遇，走／進台灣的
 * 土地」斷在詞中間）。
 *
 * 把標題切成兩段，呼叫端各包一個 inline-block：寬度夠時兩段在同一行，不夠時只會在逗號後面換行，
 * 不會從詞中間斷。標點留在前一段的結尾。找不到逗號 → 整句一段（原樣）。
 *
 *   zh「在書店相遇，走進台灣的土地」 → ["在書店相遇，", "走進台灣的土地"]
 *   en "Meet at the bookstore, step into Taiwan" → ["Meet at the bookstore,", "step into Taiwan"]
 *   ja「本屋で出会い、台湾の土地へ」 → ["本屋で出会い、", "台湾の土地へ"]
 *
 * ⚠️ 零 runtime import：scripts/events-merge-selftest.mjs 直接 import。
 */
export function splitAtComma(title: string): string[] {
  const m = /^(.+?[，、,])\s*(\S.*)$/su.exec(title.trim());
  if (!m) return [title];
  return [m[1], m[2]];
}
