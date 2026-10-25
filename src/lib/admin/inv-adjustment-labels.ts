/**
 * 在庫異動與盤點的中文標籤 —— 六類、四狀態、六原因的**單一來源**。
 *
 * 來源系統把這些字串散在四個地方（stockAdjustmentCategories.ts 一份、
 * InventoryAdjustmentDialog 一份、BatchInventoryAdjustmentDialog 一份、
 * Inventory.tsx 又一份，而且最後那份宣告了之後根本沒用）。四份總有一天會長得
 * 不一樣，而使用者看到的是最後被 render 的那一份。
 *
 * 代碼本身在 schemas.ts（那裡才是與資料庫 CHECK 對齊的地方）；這個檔案只負責
 * 「這個代碼給人看的時候長什麼樣」。
 */
import {
  INV_ADJUSTMENT_CATEGORIES,
  INV_ADJUSTMENT_REASONS,
  INV_ADJUSTMENT_STATUSES,
  type InvAdjustmentCategory,
  type InvAdjustmentReason,
  type InvAdjustmentStatus,
} from "@/lib/admin/schemas";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

export const ADJUSTMENT_CATEGORY_META: Record<
  InvAdjustmentCategory,
  { label: string; description: string; variant: BadgeVariant }
> = {
  EXP: { label: "報廢 / 損耗", description: "過期、破損、變質", variant: "destructive" },
  PR: { label: "公關贈送", description: "媒體、KOL、商務贈禮", variant: "default" },
  SMP: { label: "樣品領用", description: "試吃、研發、拍攝", variant: "secondary" },
  INT: { label: "內部領用", description: "員工餐、辦公室自用", variant: "outline" },
  ADJ: { label: "盤點調整", description: "盤點差異校正", variant: "default" },
  CMB: { label: "商品組合調整", description: "套餐組合拆分或合併", variant: "secondary" },
};

export const ADJUSTMENT_STATUS_META: Record<
  InvAdjustmentStatus,
  { label: string; variant: BadgeVariant }
> = {
  draft: { label: "草稿", variant: "secondary" },
  pending_approval: { label: "待審核", variant: "outline" },
  confirmed: { label: "已確認", variant: "default" },
  rejected: { label: "已退回", variant: "destructive" },
};

export const ADJUSTMENT_REASON_LABELS: Record<InvAdjustmentReason, string> = {
  loss: "遺失",
  damage: "損壞",
  count_error: "盤點誤差",
  return: "退貨入庫",
  sample: "樣品取用",
  other: "其他",
};

/** 下拉選單用的陣列。順序就是 schemas.ts 的宣告順序。 */
export const ADJUSTMENT_CATEGORY_OPTIONS = INV_ADJUSTMENT_CATEGORIES.map((code) => ({
  code,
  ...ADJUSTMENT_CATEGORY_META[code],
}));

export const ADJUSTMENT_STATUS_OPTIONS = INV_ADJUSTMENT_STATUSES.map((code) => ({
  code,
  ...ADJUSTMENT_STATUS_META[code],
}));

export const ADJUSTMENT_REASON_OPTIONS = INV_ADJUSTMENT_REASONS.map((code) => ({
  code,
  label: ADJUSTMENT_REASON_LABELS[code],
}));

/**
 * 資料庫裡的字串不一定在白名單裡（50 筆歷史資料是 0009 從來源整批搬進來的，
 * 0017 才補上 CHECK）。查不到就原樣顯示代碼，不要顯示 undefined。
 */
export function categoryLabel(code: string): string {
  return ADJUSTMENT_CATEGORY_META[code as InvAdjustmentCategory]?.label ?? code;
}

export function categoryVariant(code: string): BadgeVariant {
  return ADJUSTMENT_CATEGORY_META[code as InvAdjustmentCategory]?.variant ?? "outline";
}

export function statusLabel(code: string): string {
  return ADJUSTMENT_STATUS_META[code as InvAdjustmentStatus]?.label ?? code;
}

export function statusVariant(code: string): BadgeVariant {
  return ADJUSTMENT_STATUS_META[code as InvAdjustmentStatus]?.variant ?? "outline";
}

export function reasonLabel(code: string | null): string {
  if (!code) return "—";
  return ADJUSTMENT_REASON_LABELS[code as InvAdjustmentReason] ?? code;
}

/**
 * 已凍結的 inv.inventory_adjustments 只有 shrinkage / surplus 兩個值。商品詳細頁
 * 的 union view 會把它們混在六類代碼裡，所以要分 source 查。
 */
export function legacyTypeLabel(code: string): string {
  if (code === "shrinkage") return "盤虧";
  if (code === "surplus") return "盤盈";
  return code;
}

/** 進貨的審核狀態。inv.purchases.approval_status，三個值。 */
export const PURCHASE_APPROVAL_META: Record<string, { label: string; variant: BadgeVariant }> = {
  pending: { label: "待審核", variant: "outline" },
  approved: { label: "已審核", variant: "default" },
  rejected: { label: "已退回", variant: "destructive" },
};

export function purchaseApprovalLabel(code: string): string {
  return PURCHASE_APPROVAL_META[code]?.label ?? code;
}

export function purchaseApprovalVariant(code: string): BadgeVariant {
  return PURCHASE_APPROVAL_META[code]?.variant ?? "outline";
}

/** 已確認、不是沖帳單、也還沒被沖過的單才能沖帳（與 0017 的 inv_reverse_stock_adjustment 一致）。 */
export function adjustmentIsReversible(row: {
  status: string;
  reversal_of: string | null;
  reversed_by_id: string | null;
}): boolean {
  return row.status === "confirmed" && !row.reversal_of && !row.reversed_by_id;
}

/**
 * 異動單內頁上這張單現在有沒有任何動作可按（沒有就不畫手機底部的動作列）。
 * 條件與 AdjustmentActions 裡每一顆按鈕出現的條件相同。
 */
export function adjustmentHasActions(
  row: { status: string; reversal_of: string | null; reversed_by_id: string | null },
  canApprove: boolean,
): boolean {
  return (
    row.status === "draft" ||
    (row.status === "pending_approval" && canApprove) ||
    row.status === "rejected" ||
    adjustmentIsReversible(row)
  );
}
