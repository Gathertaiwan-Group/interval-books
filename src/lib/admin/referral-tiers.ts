/**
 * 推廣分潤級距 ↔ 「10000:15, 30000:20, :25」這種店長打得出來的文字（/admin/referrals 列表與
 * 推廣者編輯內頁共用）。2026-10-26 後台第 3 批從 _shell.referrals.tsx 搬出來，邏輯一行沒改。
 * 真正的驗證在 parseCommissionTiers（src/lib/referral.ts，有自檢）與 server fn 的 zod。
 */
import { parseCommissionTiers, type CommissionTier } from "@/lib/referral";

export function tiersToText(t: CommissionTier[] | null): string {
  if (!t) return "";
  return t.map((x) => `${x.upTo ?? ""}:${x.rate}`).join(", ");
}

export function textToTiers(s: string): CommissionTier[] | null {
  const parts = s
    .split(/[,，\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const raw = parts.map((p) => {
    const [a, b] = p.split(/[:：]/);
    return {
      upTo: a?.trim() ? Number(a.trim()) : null,
      rate: Number((b ?? "").replace("%", "").trim()),
    };
  });
  return parseCommissionTiers(raw);
}

export function tiersLabel(t: CommissionTier[]): string {
  let lower = 0;
  return t
    .map((x) => {
      const s =
        x.upTo === null
          ? `${lower.toLocaleString("zh-TW")} 以上 ${x.rate}%`
          : `${lower.toLocaleString("zh-TW")}–${x.upTo.toLocaleString("zh-TW")} ${x.rate}%`;
      lower = x.upTo ?? lower;
      return s;
    })
    .join("、");
}
