/**
 * 商品表單的狀態形狀。
 *
 * 全部是 string —— 受控 input 的值本來就是字串，在這一層就轉成數字的話「使用者
 * 正在打字、目前是空字串」會變成 NaN 或 0。轉型統一在送出前做一次（見
 * ProductForm 的 submit()），而且轉完馬上過 zod。
 */
import type { INV_PRODUCT_TYPES } from "@/lib/admin/schemas";

export type ProductFormState = {
  name: string;
  issue_number: string;
  barcode: string;
  category_id: string;
  product_type: (typeof INV_PRODUCT_TYPES)[number];
  series: string;
  publisher: string;
  vendor_id: string;
  selling_price: string;
  cost_price: string;
  low_stock_alert: string;
  pack_size: string;
  base_product_id: string;
  image_key: string | null;
  notes: string;
};

export const EMPTY_PRODUCT_FORM: ProductFormState = {
  name: "",
  issue_number: "",
  barcode: "",
  category_id: "",
  product_type: "outright",
  series: "",
  publisher: "",
  vendor_id: "",
  selling_price: "",
  cost_price: "",
  low_stock_alert: "5",
  pack_size: "1",
  base_product_id: "",
  image_key: null,
  notes: "",
};
