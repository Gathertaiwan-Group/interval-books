import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * 收合起來的「進階」區塊 —— 平常用不到、改錯會出事的欄位放這裡，預設收著。
 *
 * 用原生 <details> 而不是 Radix Collapsible：Collapsible 收合時會把子元素卸載，
 * 裡面的 react-hook-form 欄位雖然值還在，但驗證失敗時 RHF 想 focus 的那個 input
 * 不存在。<details> 只是隱藏、元素一直都在。
 *
 * forceOpen：區塊內有欄位驗證失敗時由呼叫端傳 true，讓錯誤訊息一定看得到。
 */
export function AdvancedSection({
  title = "進階",
  hint,
  forceOpen = false,
  children,
}: {
  title?: string;
  hint?: string;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open || forceOpen;

  return (
    <details
      open={isOpen}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-md border border-border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-4">{children}</div>
    </details>
  );
}
