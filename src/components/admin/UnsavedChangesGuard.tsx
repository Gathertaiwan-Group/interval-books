/**
 * 後台內頁的「還沒存就要離開」防呆（2026-10-25 後台第 2 批）。
 *
 * 彈窗改成內頁以後，「← 回到列表」、側欄、瀏覽器上一頁、關分頁都會直接離開這一頁——
 * 表單打到一半的內容會不見。dirty 為 true 時：
 *
 *   · 站內換頁（連結、側欄、上一頁／下一頁）→ TanStack Router useBlocker 攔下來，
 *     跳一個確認框：「留下來繼續編輯」／「放棄變更並離開」。
 *   · 關分頁、重新整理、打別的網址 → beforeunload，瀏覽器自己的確認框。
 *
 * 只在 pathname 改變時攔：同一頁換網址參數（例如分頁籤）不算離開。
 * 存檔成功後要離開：先呼叫 allowLeave() 再 navigate，否則會被自己攔下來。
 */
import { useCallback, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function useUnsavedChangesGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypassRef = useRef(false);

  const shouldBlockFn = useCallback(
    ({ current, next }: { current: { pathname: string }; next: { pathname: string } }) => {
      if (bypassRef.current || !dirtyRef.current) return false;
      return current.pathname !== next.pathname;
    },
    [],
  );
  const enableBeforeUnload = useCallback(() => dirtyRef.current && !bypassRef.current, []);

  const blocker = useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true });

  /** 存檔成功、接下來要離開這一頁時呼叫：之後的換頁不再攔。 */
  const allowLeave = useCallback(() => {
    bypassRef.current = true;
  }, []);

  const dialog = (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") blocker.reset();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>還有沒儲存的變更</AlertDialogTitle>
          <AlertDialogDescription>
            現在離開這一頁，剛剛填的內容會不見。要先留下來按「儲存」嗎？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.status === "blocked" && blocker.reset()}>
            留下來繼續編輯
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => blocker.status === "blocked" && blocker.proceed()}
          >
            放棄變更並離開
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { allowLeave, dialog };
}
