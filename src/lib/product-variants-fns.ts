/**
 * 商品頁「規格切換」的公開 server function。實作在 src/server/product-variants.ts
 * （service role 讀 inv schema，anon 讀不到）；資料格式與規則見 src/lib/product-variants.ts。
 *
 * 唯讀、不需登入，只回已上架兄弟品項的 id／slug／規格字串。
 */
import { createServerFn } from "@tanstack/react-start";
import type { VariantSource } from "@/lib/product-variants";

function coerceInput(raw: unknown): { productId: string } {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const productId = typeof o.productId === "string" ? o.productId.slice(0, 200) : "";
  return { productId };
}

export const getProductVariants = createServerFn({ method: "GET" })
  .inputValidator(coerceInput)
  .handler(async ({ data }): Promise<VariantSource[]> => {
    if (!data.productId) return [];
    const { readProductVariants } = await import("@/server/product-variants");
    return readProductVariants(data.productId);
  });
