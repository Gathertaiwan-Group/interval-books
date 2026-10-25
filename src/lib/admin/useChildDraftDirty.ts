/**
 * 內頁裡的子表單（廠商的聯絡人／匯款帳戶／附件草稿）也要算進「還沒存」的防呆。
 *
 * 子表是各自的 RPC 當場存，主表單的「儲存」不會帶它們——草稿打到一半就離開，內容一樣會不見。
 * 這兩支讓子表把「我有沒存的草稿」往上報，主表單把它併進 useUnsavedChangesGuard 的 dirty。
 */
import { useEffect, useState } from "react";
import { stableStringify } from "@/lib/admin/form-dirty";

/**
 * 開著的草稿（null = 沒開）跟「剛打開時」比有沒有改過。打開就記下基準；關掉就清掉。
 * 直接從 A 換成編輯 B 時基準仍是 A → 算改過（寧可多問一次）。
 */
export function useOpenDraftDirty<T>(draft: T | null): boolean {
  const [baseline, setBaseline] = useState<string | null>(null);
  const now = draft === null ? null : stableStringify(draft);
  if (now === null && baseline !== null) setBaseline(null);
  if (now !== null && baseline === null) setBaseline(now);
  return now !== null && baseline !== null && now !== baseline;
}

/** 把 dirty 往上報；元件卸載（換分頁籤不算，Tabs 會留著）時報 false。 */
export function useReportChildDirty(dirty: boolean, onChange?: (dirty: boolean) => void): void {
  useEffect(() => {
    onChange?.(dirty);
  }, [dirty, onChange]);
  useEffect(() => () => onChange?.(false), [onChange]);
}
