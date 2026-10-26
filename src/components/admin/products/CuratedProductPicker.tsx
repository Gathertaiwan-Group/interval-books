/**
 * 選品編輯／新增頁的「連結商品」（0041，2026-10-26）。
 *
 * 業主：首頁「主理人的選品」那一排要放主理人挑的那幾件。連了商品的選品：
 *   · 首頁那一排優先放它（買得到的書籍／選物才算，見 src/lib/home-shelf.ts）；
 *   · /shop〈主理人的選品〉那張卡多出價格與加入購物車。
 *
 * 能選的只有書籍與一般商品（含地方刊物連到庫存的那件），上架中或草稿——規則在
 * unified-products.ts#curatedLinkOptions；伺服器端 fns/curated.ts#upsertCuratedItem 再擋一次票券。
 *
 * 「自動配對」只是建議：名稱與商品標題正規化後完全相同的那幾件（suggestCuratedLinks），
 * 按「採用」才填進表單，按頁面上的儲存才寫進資料庫。
 *
 * `supported=false`＝資料庫還沒有 0041 的欄位：整格停用並說明，表單其餘照常能存。
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  filterCuratedLinkOptions,
  formatTWD,
  suggestCuratedLinks,
  type CuratedLinkOption,
} from "@/lib/admin/unified-products";

/** 搜尋結果一次最多列幾件——商品目錄不大，但不讓清單無限長。 */
const MAX_RESULTS = 30;

function stockText(o: CuratedLinkOption): string {
  if (o.stock === null) return o.stockNote || "不管理庫存";
  return `可售 ${o.stock}${o.stockNote ? `（${o.stockNote}）` : ""}`;
}

function OptionLine({ option }: { option: CuratedLinkOption }) {
  return (
    <span className="flex min-w-0 flex-col text-left">
      <span className="truncate font-medium">{option.name}</span>
      <span className="text-xs text-muted-foreground">
        {option.kindLabel}・{formatTWD(option.price)}・{stockText(option)}・{option.statusLabel}
      </span>
    </span>
  );
}

export function CuratedProductPicker({
  value,
  onChange,
  options,
  supported,
  itemName,
}: {
  value: string | null | undefined;
  onChange: (productId: string | null) => void;
  options: CuratedLinkOption[];
  supported: boolean;
  /** 表單上目前的品項名稱（三語），給「自動配對」用。 */
  itemName: { zh: string; en: string; ja: string };
}) {
  const [query, setQuery] = useState("");
  const [suggested, setSuggested] = useState<CuratedLinkOption[] | null>(null);

  const selected = value ? (options.find((o) => o.productId === value) ?? null) : null;
  const results = useMemo(
    () => filterCuratedLinkOptions(options, query).slice(0, MAX_RESULTS),
    [options, query],
  );

  if (!supported) {
    return (
      <p
        className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
        data-testid="curated-link-unsupported"
      >
        資料庫還沒有「連結商品」的欄位（migration 0041
        尚未套用），暫時不能連結。名稱、備註與發布狀態照常可以儲存。
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="curated-product-picker">
      {value ? (
        <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
          {selected ? (
            <OptionLine option={selected} />
          ) : (
            <span className="text-sm text-muted-foreground">
              已連結的商品（{value}）不在可選清單裡——可能已下架、被刪除或是票券。前台會當成沒連結。
            </span>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(null)}>
            解除連結
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">還沒連結商品：這一件在前台只展示、不販售。</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋商品名稱、代稱或進銷存品名"
          aria-label="搜尋要連結的商品"
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => setSuggested(suggestCuratedLinks(itemName, options))}
        >
          自動配對
        </Button>
      </div>

      {suggested !== null && (
        <div className="rounded-md border border-border p-3" data-testid="curated-link-suggestions">
          {suggested.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              找不到與「{itemName.zh || itemName.en || itemName.ja}
              」同名的商品。請用上面的搜尋自己挑。
            </p>
          ) : (
            <ul className="space-y-2">
              <li className="text-xs text-muted-foreground">
                同名的商品（只是建議，按「採用」才會填進來，存檔後才生效）：
              </li>
              {suggested.map((o) => (
                <li key={o.productId} className="flex items-center justify-between gap-3">
                  <OptionLine option={o} />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={o.productId === value}
                    onClick={() => {
                      onChange(o.productId);
                      setSuggested(null);
                    }}
                  >
                    {o.productId === value ? "已連結" : "採用"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ul
        className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border"
        aria-label="可以連結的商品"
      >
        {results.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">沒有符合的商品。</li>
        ) : (
          results.map((o) => (
            <li key={o.productId}>
              <button
                type="button"
                onClick={() => onChange(o.productId)}
                aria-pressed={o.productId === value}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-accent ${
                  o.productId === value ? "bg-accent" : ""
                }`}
              >
                <OptionLine option={o} />
                {o.productId === value && <span className="text-xs">已選</span>}
              </button>
            </li>
          ))
        )}
      </ul>
      <p className="text-xs text-muted-foreground">
        只列書籍與一般商品（上架中或草稿）；活動／策旅票券要先選場次，不能連。草稿可以先連，上架那天首頁自動出現。
      </p>
    </div>
  );
}
