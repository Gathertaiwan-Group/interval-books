import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PosProduct } from "@/server/repos/inv-sales";

/**
 * 商品搜尋／挑選。
 *
 * 993 個品項只有 27 個有條碼，所以這一欄其實是櫃檯最常用的入口，不是備案。
 *
 * 搜尋在記憶體裡做，不打伺服器：清單已經在 route loader 載好了，而店員一邊打字
 * 一邊等網路來回是最糟的體驗。比對 name / issue_number / series / barcode 四欄
 * （來源系統漏掉 barcode，所以在搜尋框裡貼條碼是搜不到的）。
 */
type Props = {
  products: PosProduct[];
  onPick: (product: PosProduct) => void;
  /** 已經在車上的數量，用來顯示「還能加幾件」。key 是 inv_product_id。 */
  inCart: Record<string, number>;
};

const MAX_RESULTS = 60;

export function ProductLookup({ products, onPick, inCart }: Props) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: PosProduct[] = [];
    for (const p of products) {
      const haystack = `${p.name} ${p.issue_number ?? ""} ${p.series ?? ""} ${p.barcode ?? ""}`;
      if (haystack.toLowerCase().includes(q)) {
        hits.push(p);
        if (hits.length >= MAX_RESULTS) break;
      }
    }
    return hits;
  }, [products, query]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="用書名、期數、系列或條碼搜尋"
          className="pl-8"
          aria-label="搜尋商品"
        />
      </div>

      {query.trim() ? (
        results.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-muted-foreground">
            找不到「{query.trim()}」
          </p>
        ) : (
          <ScrollArea className="h-72 rounded-md border border-border">
            <ul className="divide-y divide-border">
              {results.map((p) => {
                const remaining = p.available - (inCart[p.inv_product_id] ?? 0);
                const soldOut = !p.unlimited_stock && remaining <= 0;
                return (
                  <li key={p.inv_product_id}>
                    <button
                      type="button"
                      onClick={() => onPick(p)}
                      className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[p.series, p.issue_number, p.barcode].filter(Boolean).join("　") || "—"}
                        </span>
                        {p.units_per_item > 1 ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            賣 1 件從「{p.stock_target_name}」扣 {p.units_per_item} 個
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-sm tabular-nums">
                          NT$ {Number(p.selling_price ?? 0).toLocaleString("zh-TW")}
                        </span>
                        {/* 已售完不 disable：賣超逃生門就是為了「架上其實還有一本」
                            這種情況存在的，按不下去等於沒有逃生門。 */}
                        <Badge
                          variant={soldOut ? "destructive" : "secondary"}
                          className="mt-1 font-normal tabular-nums"
                        >
                          {p.unlimited_stock ? "不限量" : soldOut ? "可售 0" : `可售 ${remaining}`}
                        </Badge>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )
      ) : (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          共 {products.length.toLocaleString("zh-TW")} 個可販售品項
        </p>
      )}
    </div>
  );
}
