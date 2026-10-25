/**
 * 後台「商品」清單上一列的各個格子（表格與手機卡片共用）。2026-10-25 從
 * src/routes/admin/_shell.products.tsx 拆出來（那個檔案原本 1,482 行）。
 *
 * 列上的快速動作（改價、上下架、連結／解除連結、刪除）照規格留在清單上；
 * 「編輯」從開彈窗改成連到內頁（RowEditLink）：
 *   一般商品／策旅票券 → /admin/products/product/$id
 *   地方刊物           → /admin/products/publication/$id
 *   選品               → /admin/products/curated/$id
 *   活動票券           → /admin/events/$id（活動頁投影出來的商品，不在這裡編）
 * 點下去之前先 rememberAdminPeek 記下這一列，內頁 loader 還在跑時先畫標題。
 */
import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, ImageOff, Link2, Link2Off, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { rememberAdminPeek } from "@/lib/admin/list-memory";
import {
  detailKindFor,
  formatTWD,
  PRODUCT_PEEK_KIND,
  type UnifiedRow,
} from "@/lib/admin/unified-products";
import { imageFor, curatedObjects } from "@/lib/images";
import bookstoreImg from "@/assets/bookstore-interior.jpg";

function rowImage(row: UnifiedRow): string | null {
  if (row.kind === "curated") return null;
  return imageFor(row.imageKey, row.kind === "publication" ? bookstoreImg : curatedObjects);
}

export type RowProps = {
  row: UnifiedRow;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onSavePrice: (raw: string) => Promise<boolean>;
  onLink: () => void;
  onUnlink: () => void;
  onDelete: () => void;
};

export function Thumb({ row }: { row: UnifiedRow }) {
  const src = rowImage(row);
  if (!src) {
    return (
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
        <ImageOff className="h-4 w-4" aria-hidden />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className="h-12 w-12 shrink-0 rounded border border-border object-cover"
    />
  );
}

export function NameCell({ row }: { row: UnifiedRow }) {
  return (
    <div className="min-w-0">
      <p className="truncate font-medium" title={row.name}>
        {row.name}
      </p>
      {row.subtitle ? (
        <p className="truncate text-xs text-muted-foreground">{row.subtitle}</p>
      ) : null}
    </div>
  );
}

export function StockCell({ row }: { row: UnifiedRow }) {
  if (row.stock == null) {
    return <span className="text-muted-foreground">{row.stockNote || "—"}</span>;
  }
  const body = <span className="font-medium tabular-nums">{row.stock}</span>;
  if (row.invName) {
    // 可售量是進銷存算的（inv_listed_products）。點過去看那個品項的庫存與進貨。
    return (
      <Link
        to="/admin/inventory-listing"
        title={`進銷存品項：${row.invName}`}
        className="underline-offset-2 hover:underline"
      >
        {body}
      </Link>
    );
  }
  return body;
}

export function PriceCell({ row, busy, onSavePrice }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (row.price == null) {
    return (
      <span className="text-sm text-muted-foreground">
        {row.kind === "curated" ? "不販售" : "未定價"}
      </span>
    );
  }

  if (editing) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onSavePrice(draft)) setEditing(false);
        }}
      >
        <Input
          autoFocus
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          className="h-8 w-20"
          aria-label={`${row.name} 的價格`}
          disabled={busy}
        />
        <Button type="submit" size="sm" className="h-8 px-2" disabled={busy}>
          {busy ? "…" : "存"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-2"
          onClick={() => setEditing(false)}
          disabled={busy}
        >
          取消
        </Button>
      </form>
    );
  }

  const text: ReactNode = (
    <>
      {row.comparePrice != null && row.comparePrice > row.price ? (
        <span className="mr-1 text-xs line-through opacity-60">{formatTWD(row.comparePrice)}</span>
      ) : null}
      <span className="tabular-nums">{formatTWD(row.price)}</span>
    </>
  );

  if (!row.priceEditable) return <span className="text-sm">{text}</span>;
  return (
    <button
      type="button"
      onClick={() => {
        setDraft(String(row.price));
        setEditing(true);
      }}
      className="group inline-flex items-center gap-1 rounded px-1 text-sm hover:bg-muted"
      aria-label={`修改 ${row.name} 的價格`}
      data-testid="price-edit"
    >
      {text}
      <Pencil className="h-3 w-3 text-muted-foreground opacity-60 group-hover:opacity-100" />
    </button>
  );
}

export function PublishCell({ row, busy, onToggle }: RowProps) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <Switch
        checked={row.published}
        onCheckedChange={onToggle}
        disabled={busy || !row.editable}
        aria-label={`${row.name} 上架`}
        data-testid="publish-toggle"
      />
      <span className={`whitespace-nowrap ${row.published ? "" : "text-muted-foreground"}`}>
        {row.statusLabel}
      </span>
    </label>
  );
}

export function RowActions({ row, busy, onLink, onUnlink, onDelete }: RowProps) {
  if (row.eventId) {
    return (
      <Button variant="ghost" size="sm" asChild className="gap-1">
        <Link to="/admin/events/$id" params={{ id: row.eventId }}>
          到活動頁編輯
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
    );
  }
  return (
    <div className="flex justify-end gap-1">
      <RowEditLink row={row} busy={busy} />
      {row.kind === "publication" ? (
        row.productId ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`解除連結 ${row.name}`}
            title="解除商品連結"
            onClick={onUnlink}
            disabled={busy}
          >
            <Link2Off className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`連到庫存商品 ${row.name}`}
            title="連到庫存商品（開賣）"
            onClick={onLink}
            disabled={busy}
          >
            <Link2 className="h-4 w-4" />
          </Button>
        )
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:text-destructive"
          aria-label={`刪除 ${row.name}`}
          onClick={onDelete}
          disabled={busy}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

/**
 * 「編輯」：連到那一種的內頁（preload="intent"：游標移上去就先抓那一頁的資料）。
 * 列上的快速動作寫入中時先停著（與原本彈窗版一樣）：那時進內頁，loader 可能讀到
 * 寫入前的那一筆，存檔時整列寫回就把剛改的價格／上下架蓋回去。
 */
function RowEditLink({ row, busy }: { row: UnifiedRow; busy: boolean }) {
  if (busy) {
    return (
      <Button variant="ghost" size="sm" disabled data-testid="row-edit">
        編輯
      </Button>
    );
  }
  const kind = detailKindFor(row);
  const id = String(row.id);
  const remember = () => rememberAdminPeek(PRODUCT_PEEK_KIND, `${kind}:${id}`, row);
  const common = { preload: "intent", onClick: remember, "data-testid": "row-edit" } as const;
  return (
    <Button variant="ghost" size="sm" asChild>
      {kind === "publication" ? (
        <Link to="/admin/products/publication/$id" params={{ id }} {...common}>
          編輯
        </Link>
      ) : kind === "curated" ? (
        <Link to="/admin/products/curated/$id" params={{ id }} {...common}>
          編輯
        </Link>
      ) : (
        <Link to="/admin/products/product/$id" params={{ id }} {...common}>
          編輯
        </Link>
      )}
    </Button>
  );
}
