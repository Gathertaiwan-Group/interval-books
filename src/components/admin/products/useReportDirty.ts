/**
 * react-hook-form 的表單 →「有沒有改過」往上報（2026-10-25 後台第 2 批：彈窗改內頁）。
 *
 * 商品／刊物／選品的表單是 react-hook-form，未存變更防呆（useUnsavedChangesGuard）掛在
 * 內頁那一層（存檔成功要在那裡 allowLeave 再換頁）。這裡把整張表單的值丟給
 * useFormDirty 比對：第一次 render 的值是基準，改了又改回原樣不算改過。
 * ImageField／GalleryField 上傳完成會 field.onChange(新 key)，值變了一樣算改過。
 *
 * 刻意不用 RHF 自己的 formState.isDirty：所有後台內頁（廠商表單是一般 useState）都用
 * 同一個判準（form-dirty.ts 的值比對），使用者在每一頁看到的「什麼時候會被問」才一致。
 */
import { useEffect } from "react";
import { useWatch, type Control, type FieldValues } from "react-hook-form";
import { useFormDirty } from "@/lib/admin/form-dirty";

export function useReportDirty<T extends FieldValues>(
  control: Control<T>,
  onDirtyChange: ((dirty: boolean) => void) | undefined,
): void {
  const values = useWatch({ control });
  const { dirty } = useFormDirty(values);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
}
