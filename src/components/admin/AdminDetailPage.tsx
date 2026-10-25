/**
 * 後台內頁的共用外框（2026-10-25 後台第 2 批：業主「不要用彈窗，直接顯示內頁＆回到上一頁」）。
 *
 *   ┌ ← 回到列表 ───────────────────────────────┐
 *   │ [icon] 標題  [徽章…]            [動作…]   │  ← md 以上動作在右上
 *   │ 副標（編號、日期…）                         │
 *   ├────────────────────────────────────────────┤
 *   │ children                                   │
 *   └────────────────────────────────────────────┘
 *   [ 動作… ]  ← 手機（< md）改成黏在畫面底部的動作列
 *
 * 「← 回到列表」：上一筆歷史紀錄就是那個列表 → history.back()（篩選、分頁籤、捲動位置、
 * 30 秒內的 loader 快取原樣回來）；否則 → 導向列表並帶 backSearch（見 detail-nav.ts）。
 * 有未存的變更時，兩種都會被 useUnsavedChangesGuard 攔下來問一次。
 */
import type { MouseEvent, ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { backIfPreviousIs } from "@/lib/admin/detail-nav";

const WIDTH = {
  md: "max-w-3xl",
  lg: "max-w-5xl",
  xl: "max-w-6xl",
} as const;

type BackProps = {
  /** 列表的 pathname，例如 "/admin/orders"。 */
  backTo: string;
  /** 不能用上一頁時，導向列表要帶的網址參數（分頁籤、篩選）。 */
  backSearch?: Record<string, unknown>;
  backLabel?: string;
  /** 上一筆是這些頁面時也直接按上一頁（例如編輯頁：從列表或詳情進來都回原處）。 */
  backAlso?: readonly string[];
};

export function BackToListLink({
  backTo,
  backSearch,
  backLabel = "回到列表",
  backAlso = [],
}: BackProps) {
  const router = useRouter();
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // 有未存變更時 history.back() 一樣會被 useUnsavedChangesGuard 攔下來問。
    if (backIfPreviousIs(router.history, [backTo, ...backAlso])) e.preventDefault();
  }
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 gap-1.5">
      {/* to 是呼叫端給的列表路徑字串；型別上 Link 只收已註冊的路徑，這裡統一轉一次。 */}
      <Link
        to={backTo as never}
        search={(backSearch ?? {}) as never}
        preload="intent"
        onClick={onClick}
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>
    </Button>
  );
}

type Props = BackProps & {
  title: ReactNode;
  icon?: ReactNode;
  /** 緊接在標題後面（徽章）。 */
  titleExtra?: ReactNode;
  /** 標題下面一行（編號、狀態、日期）。 */
  meta?: ReactNode;
  /** 主要動作（儲存、編輯…）：md 以上在右上，手機黏在畫面底部。 */
  actions?: ReactNode;
  width?: keyof typeof WIDTH;
  children: ReactNode;
};

export function AdminDetailPage({
  backTo,
  backSearch,
  backLabel,
  backAlso,
  title,
  icon,
  titleExtra,
  meta,
  actions,
  width = "md",
  children,
}: Props) {
  return (
    <div className={cn("min-w-0 space-y-6", WIDTH[width])}>
      <div className="space-y-2">
        <BackToListLink
          backTo={backTo}
          backSearch={backSearch}
          backLabel={backLabel}
          backAlso={backAlso}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-medium">
              {icon}
              <span className="min-w-0 break-words">{title}</span>
              {titleExtra}
            </h1>
            {meta ? <div className="text-sm text-muted-foreground">{meta}</div> : null}
          </div>
          {actions ? (
            <div className="hidden shrink-0 flex-wrap items-center gap-2 md:flex">{actions}</div>
          ) : null}
        </div>
      </div>

      {children}

      {actions ? (
        <div
          className="sticky bottom-0 z-20 -mx-6 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 px-6 py-3 backdrop-blur md:hidden"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/** 內頁「找不到」的統一畫面（id 錯、已被刪）。 */
export function AdminDetailNotFound({ message, ...back }: BackProps & { message: string }) {
  return (
    <div className="space-y-4">
      <BackToListLink {...back} />
      <p className="rounded-md border border-border p-6 text-center text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

/**
 * 內頁 loader 還在跑時的畫面（route 的 pendingComponent 用）：標題列先用列表那一列的
 * 資料（list-memory 的 peek）畫出來，內容先放骨架。
 */
export function AdminDetailPending({
  title,
  titleExtra,
  meta,
  width = "md",
  ...back
}: BackProps & {
  title?: ReactNode;
  titleExtra?: ReactNode;
  meta?: ReactNode;
  width?: keyof typeof WIDTH;
}) {
  return (
    <AdminDetailPage
      {...back}
      width={width}
      title={title ?? <Skeleton className="inline-block h-6 w-48 align-middle" />}
      titleExtra={titleExtra}
      meta={meta}
    >
      <div className="space-y-3" aria-busy="true" aria-live="polite">
        <span className="sr-only">讀取中…</span>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </AdminDetailPage>
  );
}

/** pendingComponent 的時間設定：150ms 內回來就不閃骨架；出現了至少留 200ms。 */
export const ADMIN_DETAIL_PENDING = { pendingMs: 150, pendingMinMs: 200 } as const;
