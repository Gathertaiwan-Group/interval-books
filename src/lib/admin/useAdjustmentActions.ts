/**
 * 在庫異動單上的五個動作：送出、刪除草稿、重新送審、審核／退回、沖帳。
 *
 * 照 useProductActions.ts 的五步慣例：設 busy → dynamic import server fn → 看
 * 回傳決定 toast → `await refresh()` → 清 busy。
 *
 * ⚠️ 每一支都 `await refresh()`。這個 repo 沒有 react-query —— 重新抓一次就是唯一的
 *    同步方式，而它同時也是「另一個店員剛剛核准了什麼」會被看見的時機。
 *
 * ⚠️ 這裡的每一個 import 都是 dynamic。server fn 模組會把 zod schema 與 repo 一起
 *    拉進來，靜態 import 會讓它們進入首屏 bundle。
 *
 * ⚠️ 這一層**不判斷**「這張單現在能不能做這個動作」。狀態機在資料庫
 *    （inv_submit_/inv_delete_/inv_reverse_/inv_resubmit_stock_adjustment），這裡只是
 *    把它寫給店員看的整句中文原樣 toast 出來。
 *
 * 每一支回傳「這次動作有沒有成功」（失敗已經 toast 過）：異動單內頁刪除草稿成功後要回列表。
 */
import { useState } from "react";
import { toast } from "sonner";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

/** 單號可能是 null（0009 搬進來的 50 筆歷史沒有編號）。 */
function label(row: AdminAdjustmentRow): string {
  return row.adjustment_number ?? row.product_name ?? "這張單";
}

export function useAdjustmentActions(refresh: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function withRow(row: AdminAdjustmentRow, run: () => Promise<boolean>): Promise<boolean> {
    setBusyId(row.adjustment_id);
    try {
      return await run();
    } finally {
      setBusyId(null);
    }
  }

  async function handleSubmit(row: AdminAdjustmentRow): Promise<boolean> {
    return withRow(row, async () => {
      try {
        const { submitAdjustment } = await import("@/lib/admin/fns/inv-adjustments");
        const result = await submitAdjustment({ data: { id: row.adjustment_id } });
        if (!result.changed) {
          toast.info(`${label(row)} 已經有人送出過了（目前：${result.previous_status}）`);
        } else if (result.needs_approval) {
          toast.success(`${label(row)} 已送出待審核，核准後庫存才會更新`);
        } else {
          toast.success(`${label(row)} 已送出，庫存已更新`);
        }
        await refresh();
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "送出失敗");
        return false;
      }
    });
  }

  async function handleDelete(row: AdminAdjustmentRow): Promise<boolean> {
    return withRow(row, async () => {
      try {
        const { deleteAdjustment } = await import("@/lib/admin/fns/inv-adjustments");
        const result = await deleteAdjustment({ data: { id: row.adjustment_id } });
        toast.success(`已刪除草稿 ${result.adjustment_number ?? label(row)}`);
        await refresh();
        return true;
      } catch (err) {
        // 「已確認的不可刪除，請改用沖帳」是 inv_delete_stock_adjustment() 寫給店員
        // 看的整句中文，原樣顯示。
        toast.error(err instanceof Error ? err.message : "刪除失敗");
        return false;
      }
    });
  }

  async function handleResubmit(row: AdminAdjustmentRow): Promise<boolean> {
    return withRow(row, async () => {
      try {
        const { resubmitAdjustment } = await import("@/lib/admin/fns/inv-adjustments");
        const result = await resubmitAdjustment({ data: { id: row.adjustment_id } });
        toast.success(
          result.changed
            ? `${label(row)} 已重新送審`
            : `${label(row)} 已經有人處理過了（目前：${result.previous_status}）`,
        );
        await refresh();
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重新送審失敗");
        return false;
      }
    });
  }

  async function handleApprove(row: AdminAdjustmentRow, approved: boolean): Promise<boolean> {
    return withRow(row, async () => {
      try {
        const { approveRecord } = await import("@/lib/admin/fns/inv-adjustments");
        const result = await approveRecord({
          data: { module: "stock_adjustments", id: row.adjustment_id, approved },
        });
        if (!result.changed) {
          toast.info(`${label(row)} 已經有人審過了（目前：${result.previous_status ?? "未知"}）`);
        } else {
          toast.success(approved ? `${label(row)} 已核准，庫存已更新` : `${label(row)} 已退回`);
        }
        await refresh();
        return true;
      } catch (err) {
        // 沒有 approve_stock_adjustments 的人打到這裡會拿到 NotAuthorizedError ——
        // 藏按鈕只是畫面，真正擋人的是 server fn 裡那一次權限檢查。
        toast.error(err instanceof Error ? err.message : "審核失敗");
        return false;
      }
    });
  }

  async function handleReverse(row: AdminAdjustmentRow): Promise<boolean> {
    return withRow(row, async () => {
      try {
        const { reverseAdjustment } = await import("@/lib/admin/fns/inv-adjustments");
        const result = await reverseAdjustment({ data: { id: row.adjustment_id } });
        toast.success(
          `已開立沖帳單 ${result.adjustment_number ?? ""}（數量 ${result.quantity > 0 ? "+" : ""}${result.quantity}），原單保留不動`,
        );
        await refresh();
        return true;
      } catch (err) {
        // 「沖帳單不可再被沖帳」「這張單已經沖過了」都是資料庫寫的中文。
        toast.error(err instanceof Error ? err.message : "沖帳失敗");
        return false;
      }
    });
  }

  return { busyId, handleSubmit, handleDelete, handleResubmit, handleApprove, handleReverse };
}
