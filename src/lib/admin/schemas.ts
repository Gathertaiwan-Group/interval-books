/**
 * Zod schemas for the admin back office.
 *
 * localizedSchema mirrors the DB's is_localized() CHECK constraint (see
 * supabase/migrations/0001_init.sql:56-68): zh/en/ja must all be present and
 * non-empty. Validating this client-side means the 23514 constraint violation
 * never happens in practice — the form blocks submission with a field-level
 * message instead of a raw Postgres error code.
 */
import { z } from "zod";
import { LIST_MAX_ITEMS, LIST_MAX_ITEM_CHARS, splitLines } from "@/lib/admin/localized-list";
import { EVENT_BLOCK_KINDS } from "@/lib/event-blocks";
import { parseRecipients } from "@/lib/email-templates";

export const localizedSchema = z.object({
  zh: z.string().trim().min(1, "請輸入中文內容"),
  en: z.string().trim().min(1, "請輸入英文內容"),
  ja: z.string().trim().min(1, "請輸入日文內容"),
});

export type LocalizedInput = z.infer<typeof localizedSchema>;

// ---------------------------------------------------------------------------
// 「一行一項」的三語清單欄位
// ---------------------------------------------------------------------------
// 活動詳情頁的七個清單欄位（活動亮點、適合對象、不適合對象、帶得走什麼、流程大綱、
// 費用包含、注意事項）最後都存成 jsonb {"zh":[…],"en":[…],"ja":[…]}。
//
// ⚠️ 下面兩支是**明著配對**的一組，不是同一支的兩種寫法 —— 沿用
//    src/routes/admin/_shell.pages.$slug.tsx:60-90 的既有先例（那裡是
//    optionalLocalizedFormSchema 與 optionalLocalizedSchema 的配對）：
//
//      · localizedLinesFormSchema —— **表單端**。react-hook-form 綁的是三個 textarea，
//        活著的值永遠是三個「一行一項」的原始字串，不是陣列。使用者打到一半、
//        中間夾了空行、最後多一個換行，都必須算「還在編輯」而不是驗證失敗。
//      · localizedListSchema —— **送出端**。真正要進資料庫的形狀：三個 string[]。
//
//    送出前用 linesToList() 把前者換成後者（那一步會丟錯，見 localized-list.ts；
//    這裡不 slice，超過就是超過）。
//
// 分工沿用這個檔案既有的那條線：**資料庫管形狀（jsonb 是不是三個 key）、zod 管內容
// （幾項、每項多長、是不是空的）**。40／200 這兩個數字的唯一來源是 localized-list.ts，
// 不在這裡重打一次。

/** 表單端一個語言的 textarea 原始字串。 */
function localizedLinesField(lang: string) {
  return z.string().superRefine((raw, ctx) => {
    const items = splitLines(raw);
    if (items.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `請至少填一行${lang}內容` });
      return;
    }
    if (items.length > LIST_MAX_ITEMS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${lang}最多 ${LIST_MAX_ITEMS} 項，目前 ${items.length} 行，請自己刪到 ${LIST_MAX_ITEMS} 行以內`,
      });
    }
    items.forEach((line, i) => {
      if (line.length > LIST_MAX_ITEM_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${lang}第 ${i + 1} 行（共 ${items.length} 行）有 ${line.length} 個字，超過單項上限 ${LIST_MAX_ITEM_CHARS} 字`,
        });
      }
    });
  });
}

/** 送出端一個語言的 string[]。 */
function localizedListField(lang: string) {
  return z
    .array(
      z
        .string()
        .trim()
        .min(1, `${lang}的項目不可以是空的`)
        .max(LIST_MAX_ITEM_CHARS, `${lang}單項最多 ${LIST_MAX_ITEM_CHARS} 字`),
    )
    .min(1, `請至少填一項${lang}內容`)
    .max(LIST_MAX_ITEMS, `${lang}最多 ${LIST_MAX_ITEMS} 項`);
}

export const localizedLinesFormSchema = z.object({
  zh: localizedLinesField("中文"),
  en: localizedLinesField("英文"),
  ja: localizedLinesField("日文"),
});

export type LocalizedLinesFormValues = z.infer<typeof localizedLinesFormSchema>;

export const localizedListSchema = z.object({
  zh: localizedListField("中文"),
  en: localizedListField("英文"),
  ja: localizedListField("日文"),
});

export type LocalizedListInput = z.infer<typeof localizedListSchema>;

// ---------------------------------------------------------------------------
// 可以整組留空的三語清單（活動頁的七個清單欄位）
// ---------------------------------------------------------------------------
// 上面那一對（localizedLinesFormSchema／localizedListSchema）要求每個語言至少一項，
// 那是「這個欄位一定要有內容」的欄位用的。活動頁的七個清單欄位不是那樣：
//
//   🔴 **空清單的意思是「這一塊關掉」，不是「還沒填」。** 0027 把七欄都設成
//      not null default 三個空陣列，前台照順序畫、空的就整塊不畫。所以三語全空
//      必須是**合法的送出值**，而不是一個擋著儲存的錯誤。
//
// 只有「填一半」是錯的：中文三行、英日空白，前台會得到一份缺兩個語言的清單。
// 這條規則與 src/routes/admin/_shell.pages.$slug.tsx 的 optionalLocalizedFormSchema
// 是同一條，只是那裡守的是單行字串，這裡守的是「一行一項」。
//
// ⚠️ **行數對不上不在這裡擋。** 中文 4 行配英文 3 行是一個要人看見、然後自己修的
//    狀態（LocalizedListField 會跳警告、強制攤開英日區、而且在對齊之前不准收起來），
//    不是一個把整張表擋在門外的驗證錯誤 —— 擋在門外的話，人連「模型回了什麼」都
//    看不到就被踢回去了。

/** 三語全空 = 這一塊關掉；只填一半 = 錯。兩者共用的判斷。 */
function refineOptionalTriple(
  filled: [boolean, boolean, boolean],
  ctx: z.RefinementCtx,
  what: string,
): void {
  const count = filled.filter(Boolean).length;
  if (count === 0 || count === 3) return;
  const message = `${what}：三種語言要嘛一起填、要嘛一起留空（整組留空＝前台不顯示這一塊）。`;
  (["zh", "en", "ja"] as const).forEach((lang, i) => {
    if (!filled[i]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [lang], message });
  });
}

/** 表單端：三個 textarea 的原始字串，可以整組留空。 */
export const optionalLocalizedLinesFormSchema = z
  .object({ zh: z.string(), en: z.string(), ja: z.string() })
  .superRefine((val, ctx) => {
    (["zh", "en", "ja"] as const).forEach((lang) => {
      const items = splitLines(val[lang]);
      if (items.length > LIST_MAX_ITEMS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [lang],
          message: `最多 ${LIST_MAX_ITEMS} 項，目前 ${items.length} 行，請自己刪到 ${LIST_MAX_ITEMS} 行以內`,
        });
      }
      items.forEach((line, i) => {
        if (line.length > LIST_MAX_ITEM_CHARS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [lang],
            message: `第 ${i + 1} 行（共 ${items.length} 行）有 ${line.length} 個字，超過單項上限 ${LIST_MAX_ITEM_CHARS} 字`,
          });
        }
      });
    });
    refineOptionalTriple(
      [splitLines(val.zh).length > 0, splitLines(val.en).length > 0, splitLines(val.ja).length > 0],
      ctx,
      "清單欄位",
    );
  });

export type OptionalLocalizedLinesFormValues = z.infer<typeof optionalLocalizedLinesFormSchema>;

/** 送出端：三個 string[]，可以整組都是空陣列。 */
function optionalLocalizedListField(lang: string) {
  return z
    .array(
      z
        .string()
        .trim()
        .min(1, `${lang}的項目不可以是空的`)
        .max(LIST_MAX_ITEM_CHARS, `${lang}單項最多 ${LIST_MAX_ITEM_CHARS} 字`),
    )
    .max(LIST_MAX_ITEMS, `${lang}最多 ${LIST_MAX_ITEMS} 項`);
}

export const optionalLocalizedListSchema = z
  .object({
    zh: optionalLocalizedListField("中文"),
    en: optionalLocalizedListField("英文"),
    ja: optionalLocalizedListField("日文"),
  })
  .superRefine((val, ctx) => {
    refineOptionalTriple(
      [val.zh.length > 0, val.en.length > 0, val.ja.length > 0],
      ctx,
      "清單欄位",
    );
  });

export type OptionalLocalizedListInput = z.infer<typeof optionalLocalizedListSchema>;

/**
 * Covers both create and update: `id` absent/empty means "create a new row"
 * (src/server/repos/news.ts generates one). Present means "update that row".
 */
export const newsSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  display_date: z.string().trim().min(1, "請輸入顯示用日期文字，例如 2026.05.22–05.24"),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});

export type NewsFormValues = z.infer<typeof newsSchema>;

/** Shared by every resource that can be hidden from the public site. */
const publishFields = {
  id: z.string().trim().min(1).optional(),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
};

/**
 * events.registration_type is a CHECK constraint in the DB, so the enum here is
 * not a UI preference — a value outside these two is rejected by Postgres.
 */
const registrationFields = {
  /**
   * 🔴 0031：原本是 `z.string().url()`，一律要求合法網址。那是一個真的 bug——
   *    registration_type = "internal" 的活動（站內報名）本來就沒有外部網址，
   *    而正式庫已經有 5 場活動的 external_url 被清成空字串（2026-09 把「前往
   *    活動網站」從列表頁拿掉的那次改動）。這五場活動只要打開後台儲存一次，
   *    表單就會在送出前被這條規則攔下來——不是 RPC 拒絕，是連送都送不出去。
   *
   *    改用跟 artistSchema.portal_url／publicationSchema.external_url 同一個
   *    「空字串合法、非空才驗網址格式」的寫法，不是新發明的驗證方式。
   *    supabase/migrations/0031_event_gallery.sql 把 SQL 那一側
   *    admin_upsert_event_with_session() 的「不可為空」也放寬了——兩邊要一起
   *    改：只放寬這裡、不放寬 SQL，表單能送出但 RPC 還是會擋；只放寬 SQL、
   *    不放寬這裡，表單自己先擋下來，RPC 那邊的修法永遠用不到。
   */
  external_url: z
    .string()
    .trim()
    .refine(
      (v) => v === "" || v.startsWith("/") || /^https?:\/\//.test(v),
      "請輸入完整網址（含 https://）、站內路徑（/ 開頭），或留空",
    ),
  registration_type: z.enum(["external", "internal"]),
  payment_enabled: z.boolean(),
};

export const eventSchema = z.object({
  ...publishFields,
  /**
   * 網址代稱，/events/<slug>（supabase/migrations/0026_event_product_link.sql）。
   *
   * ⚠️ 0026 把它回填成 events.id，所以在那之前發出去的每一個網址仍然有效。
   *    **改這一欄會讓已經發出去的連結 404。** 表單上那一欄的說明文字要寫這句話。
   *
   * ⚠️ **不要從 title 產生 slug。** 這個站的標題是中文，常見的 slugify 套上去
   *    得到的是空字串。新增時留空就沿用 id（見 repo 的 upsertEvent）。
   */
  slug: z
    .union([
      // 空字串是合法的「沒填」（＝沿用 id），不是驗證失敗。表單那一欄是選填的
      // <Input>，沒填的時候 react-hook-form 給的就是 ""。
      z.literal(""),
      z
        .string()
        .trim()
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
          "代稱只能用英數字、連字號、底線與點，而且要以英數字開頭",
        ),
    ])
    .optional()
    .nullable(),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  display_date: z.string().trim().min(1, "請輸入顯示用日期文字"),
  // Nullable in the DB and never populated by the original content; kept
  // optional so the form does not invent a date.
  iso_date: z.string().trim().optional().nullable(),
  category: z.string().trim().min(1, "請選擇分類"),
  /**
   * 主講人。FK -> public.artists(id)，可留空（0025_event_speaker.sql）。
   *
   * 表單上是**下拉**不是自由輸入：自由輸入的話，同一位講者會以「王小明」
   * 「王 小明」「Wang Xiaoming」三種寫法散在不同活動上，而且欄位是外鍵，
   * 打錯一個字直接吃 Postgres 23503。
   */
  speaker_id: z.string().trim().min(1).optional().nullable(),
  /**
   * 封面圖 key（0026）。NULL = 沒設；前台就不畫封面，而不是畫一張每場活動都長
   * 一樣的假灰框（imageFor() 永遠會回一張圖）。這一欄會被投影到
   * products.image_key —— 同一張圖不該讓店家上傳兩次。
   */
  image_key: z.string().trim().optional().nullable(),
  /**
   * 活動相簿（0031_event_gallery.sql）。一個有序的圖片 key 陣列，值的形狀
   * 跟 image_key 同一個慣例。省略＝這一欄不動（SQL 那一側 payload 沒帶這個
   * key 時 coalesce 到舊值，不是清空），跟 highlights 等七個清單欄位是同一條
   * 「省略＝不動」規則——所以這裡也是 `.optional()`，不是 `.default([])`。
   */
  gallery_keys: z.array(z.string().trim().min(1)).optional(),
  ...registrationFields,
  /**
   * 前台印不印這場活動的「尚餘名額 N」（0029_event_seats_visibility.sql）。
   *
   * ⚠️ **不在 registrationFields 裡。** 那一組是 events 與 journeys 共用的
   *    （見上面兩個 spread），而 public.journeys 沒有這一欄 —— 放進去會讓策旅
   *    表單多送一個資料庫不認得的欄位。
   *
   * 🔴 這一欄只管「還剩幾位」那一句。**「已額滿」不受它影響**，那是「你報不了名」。
   */
  show_seats_remaining: z.boolean(),
});
export type EventFormValues = z.infer<typeof eventSchema>;

/**
 * 活動商品那一段。上架、改價、下架都走這裡。
 *
 * ⚠️ **沒有 title / summary / description / slug / image_key。** 那五樣是從活動
 *    投影過去的，規則住在 supabase/migrations/0026 的
 *    admin_upsert_event_with_session() 裡（其中 products.description 取的是
 *    events.summary，不是 events.description）。這裡多開一個欄位，就是替那條規則
 *    開第二個家。
 *
 * ⚠️ 也沒有 capacity。名額的唯一真相是 public.event_sessions（0020），
 *    products.capacity 被 CHECK 強制成 null。
 */
export const eventProductSchema = z.object({
  price: z.number().int("價格必須是整數").min(0, "價格不能是負數"),
  compare_at_price: z.number().int("原價必須是整數").min(0, "原價不能是負數").nullable().optional(),
  status: z.enum(["draft", "active", "archived"]),
  sort_order: z.number().int("排序必須是整數").optional(),
});
export type EventProductFormValues = z.infer<typeof eventProductSchema>;

/**
 * 活動頁那七個「一行一項」清單欄位（0027）。**順序就是前台由上到下的順序**，唯一的
 * 名單在 src/lib/event-blocks.ts 的 EVENT_LIST_FIELDS，自檢會拿那一份逐欄回來對帳。
 *
 * 🔴 **只掛在 eventWithProductSchema 上，不掛在 eventSchema 上。** 這七欄只有一條寫得
 *    進資料庫的路：0027 的 admin_upsert_event_with_session()。掛到 eventSchema 上等於
 *    讓 upsertEvent()（只寫 public.events 的固定欄位，不碰這七欄）也「收得下」它們 ——
 *    zod 會安靜地把它們留在 payload 裡，repo 安靜地不寫，使用者看到「已儲存」而七欄
 *    原封不動。那是這個 repo 反覆點名的那種靜默無效。
 *
 * 每一欄都 `.optional()`：**沒帶那個 key ＝那一欄不動**（與 SQL 那一側的 coalesce 同一
 * 條規則），送 `{"zh":[],"en":[],"ja":[]}` 才是「清空這一塊」——那是一個看得見的動作。
 */
const eventListFields = {
  highlights: optionalLocalizedListSchema.optional(),
  suitable_for: optionalLocalizedListSchema.optional(),
  not_suitable_for: optionalLocalizedListSchema.optional(),
  takeaways: optionalLocalizedListSchema.optional(),
  outline: optionalLocalizedListSchema.optional(),
  includes: optionalLocalizedListSchema.optional(),
  notes: optionalLocalizedListSchema.optional(),
};

/**
 * 活動 + 商品，一次送出。`product` 省略／null = 這一次不動商品那一列。
 *
 * 0027 起這條路也吃七個清單欄位 —— 活動頁組裝器的「儲存」是**一支 server fn、一次
 * RPC、一個交易**，所以固定欄位與七個清單不會出現「前半段寫進去了、後半段沒有」。
 */
export const eventWithProductSchema = eventSchema.extend({
  ...eventListFields,
  product: eventProductSchema.nullable().optional(),
});
export type EventWithProductFormValues = z.infer<typeof eventWithProductSchema>;

/**
 * 「一頁新增活動」送進 server fn 的形狀（src/lib/admin/event-quick-create.ts 的
 * QuickCreateInput）。
 *
 * ⚠️ 這裡只守**形狀與上限**。內容規則（結束晚於開始、站內報名至少一場、付費至少一個
 *    票種…）只有一個家：validateQuickCreate()，server 寫入前會再跑一次。在這裡再寫
 *    一份 superRefine 就是兩份會分岔的規則。
 */
export const eventQuickCreateSchema = z.object({
  kind: z.enum(["event", "journey"]),
  title: z.string().max(500),
  category: z.string().max(200),
  speaker_id: z.string().max(200).nullable(),
  image_key: z.string().max(500).nullable(),
  description: z.string().max(4000),
  sessions: z
    .array(
      z.object({
        date: z.string().max(10),
        start: z.string().max(5),
        end: z.string().max(5),
        end_date: z.string().max(10),
        location: z.string().max(500),
        capacity: z.number().int(),
      }),
    )
    .max(20),
  mode: z.enum(["free", "paid", "external"]),
  plans: z.array(z.object({ name: z.string().max(200), price: z.number().int() })).max(10),
  external_url: z.string().max(2000),
  publish: z.boolean(),
  theme: z.string().max(500),
});

/**
 * 一列 event_blocks（0027）。三種 kind 共用這一支，因為它們的形狀**完全相同**。
 *
 * 🔴 `kind` 的名單來自 EVENT_BLOCK_KINDS，不是在這裡再打一次三個字串 —— 那三個字要
 *    與 0027 的 `event_blocks_kind_valid` CHECK 逐字相等，而 scripts/event-blocks-selftest.mjs
 *    對帳的是 EVENT_BLOCK_KINDS 那一份。抄第二份就是抄一份沒有人在對帳的。
 *
 * 🔴 **沒有 sort_order。** 排序的唯一入口是 public.admin_reorder_event_blocks()
 *    （見 src/server/repos/event-blocks.ts 的檔頭）；讓它出現在這支 schema 上，等於
 *    在「編輯這一列的文字」這條路上開一個改順序的後門，而那個後門會撞上
 *    unique(event_id, kind, sort_order)。
 *
 * title / body 都用 localizedSchema（不是 optional 的那一支）：0027 兩欄都 not null，
 * 而「把英文清空當作刪掉這一列」在三語下會壞（中文也一起不見）。要刪就刪。
 */
export const eventBlockSchema = z.object({
  /** 有 id ＝ 改既有那一列；沒有 ＝ 新增一列（sort_order 由 repo append）。 */
  id: z.number().int().nullable().optional(),
  event_id: z.string().trim().min(1),
  kind: z.enum(EVENT_BLOCK_KINDS),
  title: localizedSchema,
  body: localizedSchema,
});
export type EventBlockFormValues = z.infer<typeof eventBlockSchema>;

export const eventCategorySchema = z.object({
  id: z.string().trim().min(1, "請輸入分類代碼"),
  label: localizedSchema,
  sort_order: z.number().int("排序必須是整數"),
});
export type EventCategoryFormValues = z.infer<typeof eventCategorySchema>;

export const journeySchema = z.object({
  ...publishFields,
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  days: localizedSchema,
  theme: localizedSchema,
  ...registrationFields,
});
export type JourneyFormValues = z.infer<typeof journeySchema>;

export const collaborationSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  description: localizedSchema,
});
export type CollaborationFormValues = z.infer<typeof collaborationSchema>;

// ---------------------------------------------------------------------------
// 講者（public.artists）
// ---------------------------------------------------------------------------
/**
 * 一位講者可編輯的欄位。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 這裡**一個 localizedSchema 都沒有**，而那是故意的
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * public.artists 的 bio / long_bio / discipline 在資料庫裡是 `text`，不是
 * `jsonb`（supabase/migrations/0019_vendors_pii_portal.sql:2146-2160）。這張表上
 * 唯一的第二語言是 name 與 name_en —— 兩個獨立的 text 欄位，不是一個三語物件。
 *
 * 所以：
 *   · 不可以對這些欄位用 localizedSchema；
 *   · 不可以把它們丟進 <LocalizedField>（那個元件讀寫 `${name}.zh` 這種路徑，
 *     套在字串欄位上會把 "王小明" 變成 {zh: undefined}）；
 *   · 不可以丟給自動翻譯（src/lib/admin/fns/translate.ts）—— 人名尤其不該被
 *     機器翻譯。
 *
 * 這件事型別上擋得住（`string` 不相容 `{zh,en,ja}`），但只要中間過一層 any 或
 * 型別斷言就會安靜地變成畫面上的 "[object Object]"。所以後台 UI 那一側另外用
 * 文字明講「此欄不分語言，三種語系都會顯示同一份內容」，而不是只靠型別。
 *
 * 要不要把 bio 升級成三語 jsonb 是另一期的決定（需要一支資料搬遷 migration），
 * 不在這一期範圍內。
 *
 * ⚠️ 也**沒有** vendor_id。那是指到 inv.vendors 的會計面綁定（那張表有身分證
 *    字號與匯款帳號），與門面資料是兩個不同的授權決定。zod 預設剝掉未宣告的
 *    key，所以這個 schema 同時是 UI 的欄位清單與 server fn 的輸入白名單。
 *    完整理由見 src/server/repos/artists.ts 的檔頭。
 */
export const artistSchema = z.object({
  id: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1, "請輸入網址代稱"),
  name: z.string().trim().min(1, "請輸入講者姓名"),
  name_en: z.string().trim().max(200).optional().nullable(),
  discipline: z.string().trim().max(200).optional().nullable(),
  bio: z.string().trim().max(2000).optional().nullable(),
  long_bio: z.string().trim().max(20000).optional().nullable(),
  image_key: z.string().trim().max(300).optional().nullable(),
  // 空字串代表「沒有個人網站」，所以不能用 z.string().url() 硬擋（同
  // publicationSchema.external_url 的處理）。
  portal_url: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || /^https?:\/\//.test(v), "請輸入完整網址（含 https://）或留空")
    .optional()
    .nullable(),
  sort_order: z.number().int("排序必須是整數"),
  is_active: z.boolean(),
});
export type ArtistFormValues = z.infer<typeof artistSchema>;

export const curatedThemeSchema = z.object({
  ...publishFields,
  title: localizedSchema,
  description: localizedSchema,
});
export type CuratedThemeFormValues = z.infer<typeof curatedThemeSchema>;

/** curated_items.id is a bigint identity, so it is a number rather than text. */
export const curatedItemSchema = z.object({
  id: z.number().int().optional(),
  theme_id: z.string().trim().min(1),
  name: localizedSchema,
  note: localizedSchema,
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
  /**
   * 連到的商品（curated_items.product_id，0041）。null＝只展示；沒給＝不動這一欄。
   * 只能是書籍／選物——伺服器端 fns/curated.ts#upsertCuratedItem 會再查一次那件商品的類型。
   */
  product_id: z.string().trim().min(1).max(200).nullable().optional(),
});
export type CuratedItemFormValues = z.infer<typeof curatedItemSchema>;

/* ------------------------------------------------------------------ *
 * Phase 3 — page copy and site-wide settings
 * ------------------------------------------------------------------ */

/**
 * A localized field that genuinely may be absent. Only for DB columns that are
 * nullable — when the column is NOT NULL, use `localizedSchema`, because
 * is_localized() rejects partial objects.
 */
const optionalLocalizedSchema = localizedSchema.nullable().optional();

/** `pages` is one row per route. Rows are never created or deleted here. */
export const pageMetaSchema = z.object({
  slug: z.string().trim().min(1),
  meta_title: localizedSchema,
  meta_description: localizedSchema,
  og_title: optionalLocalizedSchema,
  og_description: optionalLocalizedSchema,
  og_image_key: z.string().trim().nullable().optional(),
  eyebrow_prefix: z.string().trim().nullable().optional(),
  eyebrow_suffix: optionalLocalizedSchema,
  header_title: optionalLocalizedSchema,
  header_intro: optionalLocalizedSchema,
});
export type PageMetaFormValues = z.infer<typeof pageMetaSchema>;

/**
 * Block keys are consumed by hard-coded component code, so the admin edits
 * values only — it never adds or removes a key.
 */
export const pageBlockSchema = z.object({
  id: z.number().int(),
  block_key: z.string(),
  value: localizedSchema,
});
export const pageBlocksBulkSchema = z.object({
  page_slug: z.string().trim().min(1),
  blocks: z.array(pageBlockSchema),
});
export type PageBlocksBulkValues = z.infer<typeof pageBlocksBulkSchema>;

/** Unlike blocks, list rows are genuinely addable — a route can gain a stop. */
export const pageListItemSchema = z.object({
  id: z.number().int().optional(),
  page_slug: z.string().trim().min(1),
  list_key: z.string().trim().min(1),
  label: localizedSchema,
  note: optionalLocalizedSchema,
  image_key: z.string().trim().nullable().optional(),
  sort_order: z.number().int(),
});
export type PageListItemFormValues = z.infer<typeof pageListItemSchema>;

/** Single row, `check (id = 1)` — update only, never insert or delete. */
/**
 * 店家新訂單／新報名通知信收件人（public.site_settings.notify_emails，0032）。
 *
 * 空字串合法——代表「先不寄」，src/server/repos/email-outbox.ts 的
 * enqueueAdminOrderEmail() 與 0032 的 enqueue_admin_order_email() 都把空收件人
 * 當成安靜跳過，不是錯誤，這裡不該逼使用者填點什麼才能存檔。
 *
 * 非空時，用 parseRecipients()（src/lib/email-templates.ts，同一支邏輯負責把
 * 這一欄拆成 Resend 要的地址陣列）拆開，每一段都要像 email。這是送出前的第一道
 * 防線：純標點符號（例如打成一串逗號）在這裡就會被擋下來，不用等寄信那一步
 * 燒掉重試額度才發現收件人是空的。
 */
const EMAIL_LIKE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const notifyEmailsSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      if (value === "") return true;
      const parts = parseRecipients(value);
      return parts.length > 0 && parts.every((p) => EMAIL_LIKE_RE.test(p));
    },
    { message: "請輸入有效的電子郵件，多個地址用逗號分隔（留白＝先不寄通知信）" },
  );

export const siteSettingsSchema = z.object({
  short_desc: localizedSchema,
  address: localizedSchema,
  city: localizedSchema,
  hours: localizedSchema,
  closed: localizedSchema,
  contact_email: z.string().trim().email("請輸入有效的電子郵件"),
  site_url: z.string().trim().url("請輸入完整網址"),
  // Empty string is meaningful: the footer hides links whose value is blank.
  social_instagram: z.string().trim(),
  social_facebook: z.string().trim(),
  social_line: z.string().trim(),
  map_embed: z.string().trim(),
  map_link: z.string().trim(),
  map_apple: z.string().trim(),
  meta_site_name: z.string().trim(),
  meta_author: z.string().trim(),
  meta_twitter_card: z.string().trim(),
  meta_og_type: z.string().trim(),
  default_meta_title: z.string().trim(),
  default_meta_description: z.string().trim(),
  notify_emails: notifyEmailsSchema,
});
export type SiteSettingsFormValues = z.infer<typeof siteSettingsSchema>;

/** Composite PK (group_key, string_key) — both identify the row, not editable. */
export const uiStringSchema = z.object({
  group_key: z.string().trim().min(1),
  string_key: z.string().trim().min(1),
  value: localizedSchema,
  sort_order: z.number().int(),
});
export type UiStringFormValues = z.infer<typeof uiStringSchema>;

/** Plain text throughout — these are phone numbers, not prose. */
export const contactPhoneSchema = z.object({
  id: z.number().int().optional(),
  label: z.string().trim().min(1, "請輸入標籤"),
  display_text: z.string().trim().min(1, "請輸入顯示文字"),
  tel: z.string().trim().min(1, "請輸入撥號用號碼"),
  sort_order: z.number().int(),
});
export type ContactPhoneFormValues = z.infer<typeof contactPhoneSchema>;

/* ------------------------------------------------------------------ *
 * Commerce — products
 * ------------------------------------------------------------------ */

const PRODUCT_TYPES = ["goods", "book", "event", "journey"] as const;
const PRODUCT_SOURCE_TYPES = ["event", "journey", "curated_item"] as const;
const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;

/**
 * products.id is a plain `text primary key` with no DB default (same shape as
 * news.id — see src/server/repos/products.ts), so `id` absent/empty means
 * "create a new row", same convention as newsSchema.
 *
 * ⚠️ `capacity` 與 `seats_taken` **都不是這張表單的欄位**，而且不可以加回來。
 *
 * 0004 原本有一條 products_capacity_shape CHECK 要求 event/journey 必須填名額，
 * 這個 schema 也照著做了一條 superRefine。0020 把名額整個搬到
 * public.event_sessions，並且用 `products_capacity_moved_to_sessions` 這條新
 * CHECK 強制 `capacity is null and seats_taken = 0` —— 所以那條 superRefine 現在
 * 會逼使用者填一個資料庫拒收的值。名額改在「活動報名」頁按場次維護。
 *
 * `seats_taken` 從來就不是這裡的欄位，理由見 src/server/repos/products.ts：
 * 表單寫回一個幾分鐘前讀到的計數器，就是 reserve_session_seat() 存在的理由。
 */
export const productSchema = z.object({
  id: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1, "請輸入網址代稱"),
  product_type: z.enum(PRODUCT_TYPES),
  // Optional link back to the CMS row this product is sold from — plain
  // fields, not a picker (see src/routes/admin/_shell.products.tsx).
  source_type: z.enum(PRODUCT_SOURCE_TYPES).nullable().optional(),
  source_id: z.string().trim().nullable().optional(),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  // TWD, whole dollars — never cents (see migration comment).
  price: z.number().int("價格必須是整數，不接受小數").min(0, "價格不可為負數"),
  compare_at_price: z
    .number()
    .int("原價必須是整數，不接受小數")
    .min(0, "原價不可為負數")
    .nullable()
    .optional(),
  // Physical goods only. NULL means "not stock-managed".
  stock: z
    .number()
    .int("庫存必須是整數，不接受小數")
    .min(0, "庫存不可為負數")
    .nullable()
    .optional(),
  image_key: z.string().trim().nullable().optional(),
  requires_shipping: z.boolean(),
  status: z.enum(PRODUCT_STATUSES),
  sort_order: z.number().int("排序必須是整數"),
});

export type ProductFormValues = z.infer<typeof productSchema>;

/**
 * 一個梯次（public.event_sessions，0020 §1）。
 *
 * ⚠️ 沒有 `seats_taken`。它只由三支持有列鎖的 SQL 函式維護，見
 *    src/server/repos/event-sessions.ts 的檔頭。
 *
 * `capacity` 有，因為調降名額是合法的後台動作 —— 而且資料庫會擋下降到低於
 * seats_taken 的那一種（event_sessions_seats_within_capacity），所以「已經有 12 人
 * 報名卻想改成 10」會當場失敗，而不是留下一個超過自己上限的場次。
 */
export const eventSessionSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    product_id: z.string().trim().min(1, "請選擇活動商品"),
    title: localizedSchema,
    location: localizedSchema,
    // datetime-local 的值（YYYY-MM-DDTHH:mm），由路由轉成 ISO 再送出。
    starts_at: z.string().trim().min(1, "請輸入開始時間"),
    ends_at: z.string().trim().nullable().optional(),
    capacity: z.number().int("名額必須是整數，不接受小數").min(0, "名額不可為負數"),
    status: z.enum(["open", "closed"]),
    sort_order: z.number().int("排序必須是整數"),
  })
  .superRefine((data, ctx) => {
    // 與 0020 的 event_sessions_time_order CHECK 逐字對應。放在這裡是為了讓錯誤
    // 印在「結束時間」那個輸入框旁邊，而不是變成一句 23514。
    const ends = (data.ends_at ?? "").trim();
    if (ends !== "" && ends < data.starts_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "結束時間不可以早於開始時間",
        path: ["ends_at"],
      });
    }
  });

export type EventSessionFormValues = z.infer<typeof eventSessionSchema>;

/**
 * 一個場次底下的價格方案／票種（public.event_session_plans，0036）。
 *
 * ⚠️ 沒有 `units_taken`，理由與 eventSessionSchema 沒有 `seats_taken`逐字相同：
 *    它只由持有列鎖的 SQL 函式維護（見 src/server/repos/event-sessions.ts
 *    對應段落的檔頭）。
 *
 * ⚠️ 這個 schema 值**必須動態匯入**，不可以像 `eventSessionSchema` 那樣被表單
 *    元件在檔案頂層靜態匯入——`scripts/bundle-admin-leak-selftest.mjs` 守著
 *    後台專用字串不能流進訪客必載的 bundle，而這個檔案（schemas.ts）已經被
 *    100 處靜態匯入命中，其中包含路由檔本身；新增的表單元件如果也走靜態匯入，
 *    就是再多開一個「只被 component 呼叫的 sibling 函式」洩漏點。呼叫端見
 *    src/routes/admin/_shell.registrations.tsx 的方案表單。
 */
export const eventSessionPlanSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    session_id: z.string().trim().min(1, "缺少所屬場次"),
    title: localizedSchema,
    price: z.number().int("價格必須是整數，不接受小數").min(0, "價格不可為負數"),
    seats_per_unit: z.number().int("每單位佔用的名額必須是整數").min(1, "每單位至少佔用 1 個名額"),
    capacity: z.number().int("名額必須是整數，不接受小數").min(0, "名額不可為負數"),
    // datetime-local 的值，空字串＝不限（null）。由路由轉成 ISO 再送出。
    sale_starts_at: z.string().trim().nullable().optional(),
    sale_ends_at: z.string().trim().nullable().optional(),
    status: z.enum(["open", "closed"]),
    sort_order: z.number().int("排序必須是整數"),
  })
  .superRefine((data, ctx) => {
    // 與 0036 的 event_session_plans_sale_window CHECK 逐字對應：兩個時間都填
    // 才比較，放在這裡是為了讓錯誤印在「販售結束時間」那個輸入框旁邊。
    const starts = (data.sale_starts_at ?? "").trim();
    const ends = (data.sale_ends_at ?? "").trim();
    if (starts !== "" && ends !== "" && ends < starts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "販售結束時間不可以早於開始時間",
        path: ["sale_ends_at"],
      });
    }
  });

export type EventSessionPlanFormValues = z.infer<typeof eventSessionPlanSchema>;

/**
 * 上架表單：把一個進銷存品項變成型錄商品。
 *
 * 刻意**沒有** stock 欄位。上架後這件商品的庫存由 inv.products 管，
 * public.products.stock 必須是 NULL —— 0011 有一個 trigger 會擋下任何非 NULL 的值。
 * 表單裡不放這個欄位，是為了讓「這個數字不存在」這件事在 UI 上就成立，
 * 而不是等到送出才被資料庫罵。
 *
 * product_type 只留 goods / book：event 與 journey 是有名額的預約，不走實體庫存。
 */
export const inventoryListingSchema = z.object({
  inv_product_id: z.string().trim().uuid("請從清單選一個進銷存品項"),
  slug: z.string().trim().min(1, "請輸入網址代稱"),
  title: localizedSchema,
  summary: localizedSchema,
  description: localizedSchema,
  price: z.number().int("價格必須是整數，不接受小數").min(0, "價格不可為負數"),
  units_per_sale: z.number().int("每件出貨數必須是整數").min(1, "每件出貨數至少是 1"),
  product_type: z.enum(["goods", "book"]),
  status: z.enum(["draft", "active"]),
  /** 上架頁不填；/admin/publications 連結刊物時會把封面帶進來。 */
  image_key: z.string().trim().optional().nullable(),
});

export type InventoryListingFormValues = z.infer<typeof inventoryListingSchema>;

// ---------------------------------------------------------------------------
// 地方刊物展
// ---------------------------------------------------------------------------
/**
 * 一本刊物可編輯的欄位。
 *
 * sheet / seq / slug 不在裡面：它們是回頭對照原始 Excel 的鍵，改了就再也對不回去。
 * region 允許空字串 —— 原始資料裡真的有「日本全國」這種不是地名的寫法，強迫填
 * 一個縣市只會逼人編造。
 */
export const publicationSchema = z.object({
  id: z.string().trim().min(1),
  title: localizedSchema,
  publisher: localizedSchema,
  intro: localizedSchema,
  region: z.string().trim().max(200),
  issues: z.string().trim().max(500).optional().nullable(),
  // 空字串代表「原始資料沒有網址」，所以不能用 z.string().url() 硬擋。
  external_url: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || /^https?:\/\//.test(v), "請輸入完整網址（含 https://）或留空")
    .optional()
    .nullable(),
  cover_image_key: z.string().trim().optional().nullable(),
  is_published: z.boolean(),
  sort_order: z.number().int("排序必須是整數"),
});

export type PublicationFormValues = z.infer<typeof publicationSchema>;

/**
 * 把一本刊物連到進銷存的一個品項。
 *
 * price 最低 1：0 元商品在結帳、發票與金流三個地方都是特例，而「還沒定價」的
 * 正確表達方式是**不要連結**，不是連了填 0。
 */
export const publicationLinkSchema = z.object({
  publication_id: z.string().trim().min(1),
  inv_product_id: z.string().trim().uuid("請從清單選一個進銷存品項"),
  price: z.number().int("價格必須是整數，不接受小數").min(1, "請填入售價（至少 1 元）"),
  units_per_sale: z.number().int("每件出貨數必須是整數").min(1, "每件出貨數至少是 1"),
});

export type PublicationLinkFormValues = z.infer<typeof publicationLinkSchema>;

// ---------------------------------------------------------------------------
// 門市 POS
// ---------------------------------------------------------------------------
/**
 * 結帳一車。
 *
 * ⚠️ 這裡的每一條規則都是 DB 端 CHECK 或 pos_checkout() 的鏡射，不是新發明的：
 *    quantity > 0        ← inv.sales 的 positive_quantity CHECK
 *    unit_price >= 0     ← inv.sales 的 non_negative_unit_price CHECK
 *    items 非空          ← pos_checkout() 的 POS_EMPTY_CART
 *
 * 鏡射的意義是「錯誤在按鈕旁邊，而不是在 500 頁面上」。資料庫那一份仍然是真正
 * 的守門 —— 來源系統就是因為前端 `parseFloat('')` 沒擋，讓 NaN 寫進了 unit_price。
 */
export const posCheckoutSchema = z.object({
  items: z
    .array(
      z.object({
        inv_product_id: z.string().trim().uuid(),
        quantity: z.number().int("數量必須是整數").min(1, "數量至少是 1"),
        unit_price: z
          .number({ invalid_type_error: "單價必須是數字" })
          .min(0, "單價不可為負數")
          .finite("單價必須是數字"),
      }),
    )
    .min(1, "購物車是空的"),
  payment_method_id: z.string().trim().uuid().nullable(),
  sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  notes: z.string().trim().max(500, "備註最多 500 字").nullable(),
  /** 逃生門。true 會略過可售量下限並在 stock_oversold_alerts 留一列。 */
  override_reservation: z.boolean(),
});

export type PosCheckoutValues = z.infer<typeof posCheckoutSchema>;

/** 銷售紀錄的篩選條件。全部下推到資料庫，不在前端 filter。 */
export const salesFilterSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  channel: z.enum(["all", "pos", "online"]),
  keyword: z.string().trim().max(100).nullable(),
  reconciled: z.enum(["all", "yes", "no"]),
  paymentMethodId: z.string().trim().uuid().nullable(),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type SalesFilterValues = z.infer<typeof salesFilterSchema>;

/** 標記賣超告警已處理。說明是必填 —— 「已處理」但沒說怎麼處理等於沒處理。 */
export const resolveAlertSchema = z.object({
  alert_id: z.number().int().positive(),
  note: z.string().trim().min(1, "請寫下你怎麼處理的").max(500, "最多 500 字"),
});

export type ResolveAlertValues = z.infer<typeof resolveAlertSchema>;

// ---------------------------------------------------------------------------
// 進銷存商品主檔
// ---------------------------------------------------------------------------
/**
 * 商品類型。**三個值，不是六個**。
 *
 * 來源系統的 productTypes.ts 列了六種（outright / consignment / commission /
 * own_brand / rental / secondhand），但 inv.products 的 CHECK 只認得三種：
 *
 *   CONSTRAINT products_product_type_check
 *     CHECK (product_type = ANY (ARRAY['outright', 'consignment', 'rental']))
 *
 * 鏡射的是**資料庫**，不是來源的下拉選單。多送另外三個進去會拿到 23514，
 * 而 23514 出現在使用者眼前的樣子是一頁 500。
 */
export const INV_PRODUCT_TYPES = ["outright", "consignment", "rental"] as const;
export const INV_PRODUCT_TYPE_LABELS: Record<(typeof INV_PRODUCT_TYPES)[number], string> = {
  outright: "買斷",
  consignment: "寄賣",
  rental: "租借（展示用）",
};

/**
 * 商品表單。
 *
 * ⚠️ 這裡**沒有** approval_status、stock_quantity、user_id。不是漏了：
 *    · approval_status 由 inv.initial_approval_status() 在資料庫算（fail-closed）
 *    · stock_quantity 只能由進貨／盤點改
 *    · user_id 取自 middleware 的 context
 *    三者都不從 request body 拿。inv_save_product() 逐欄具名取值，所以就算有人
 *    把這些 key 塞進 payload 也不會有任何一行程式去讀它。
 *
 * 價格的下限鏡射 inv.products 的 positive_cost_price / positive_selling_price。
 */
export const invProductSchema = z.object({
  id: z.string().trim().uuid().nullable().optional(),
  name: z.string().trim().min(1, "請輸入商品名稱").max(200, "商品名稱最多 200 字"),
  issue_number: z.string().trim().max(50).nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  category_id: z.string().trim().uuid().nullable().optional(),
  product_type: z.enum(INV_PRODUCT_TYPES),
  series: z.string().trim().max(200).nullable().optional(),
  publisher: z.string().trim().max(200).nullable().optional(),
  vendor_id: z.string().trim().uuid().nullable().optional(),
  selling_price: z
    .number({ invalid_type_error: "售價必須是數字" })
    .min(0, "售價不可為負數")
    .finite("售價必須是數字"),
  cost_price: z
    .number({ invalid_type_error: "成本必須是數字" })
    .min(0, "成本不可為負數")
    .finite("成本必須是數字")
    .nullable()
    .optional(),
  low_stock_alert: z.number().int("低庫存警示必須是整數").min(0, "不可為負數"),
  pack_size: z.number().int("每組數量必須是整數").min(1, "每組數量至少是 1"),
  base_product_id: z.string().trim().uuid().nullable().optional(),
  image_key: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** 只在新增時看。來源新增商品預設會一起建一筆進貨，庫存靠它的 trigger 加上去。 */
  purchase: z
    .object({
      quantity: z.number().int("數量必須是整數").min(1, "數量至少是 1"),
      cost_price: z.number().min(0, "成本不可為負數").finite().nullable(),
      vendor: z.string().trim().max(200).nullable(),
      purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
    })
    .nullable()
    .optional(),
});

export type InvProductFormValues = z.infer<typeof invProductSchema>;

/**
 * 審核的七個模組。
 *
 * ⚠️ 這是一份**代號**清單，不是表名清單。哪一個代號對到哪一張表、哪一個狀態
 *    欄位，只寫在 0016 的 public.inv_approve_record() 裡面（寫死的 CASE 分支，
 *    沒有動態 SQL）。這一層的責任只是「不在這七個裡面的字串連 server fn 都進不去」。
 *
 * 來源的 useApprovalMutation({ table, statusField }) 是讓呼叫端自己傳表名與欄位名。
 * 在來源那個單體前端裡它只是難維護；搬到 client/server 之後那個 table 會**從
 * 瀏覽器送進來**，等於把 `update <任意表> set <任意欄位>` 開給任何拿得到 cookie
 * 的人。就算今天用參數化查詢擋得住，下一個人加一段字串拼接就破了 —— 所以修法
 * 不是「小心一點」，是讓表名根本不會出現在網路上。
 *
 * price_changes 不是一張表（它是 inv.products 上的另一組欄位），
 * stock_adjustments 的狀態欄位叫 status 而不是 approval_status，通過的值是
 * 'confirmed' 而不是 'approved'。這兩件事本身就說明了「module = 表名」行不通。
 */
export const APPROVAL_MODULES = [
  "products",
  "purchases",
  "stock_adjustments",
  "inventory_adjustments",
  "combo_sets",
  "vendors",
  "price_changes",
] as const;

export type ApprovalModule = (typeof APPROVAL_MODULES)[number];

export const APPROVAL_MODULE_LABELS: Record<ApprovalModule, string> = {
  products: "商品新增",
  purchases: "進貨",
  stock_adjustments: "盤點",
  inventory_adjustments: "庫存異動",
  combo_sets: "套餐組合",
  vendors: "供應商",
  price_changes: "商品價格變更",
};

export const approveRecordSchema = z.object({
  module: z.enum(APPROVAL_MODULES),
  id: z.string().trim().uuid("請指定一筆有效的資料"),
  approved: z.boolean(),
});

export type ApproveRecordValues = z.infer<typeof approveRecordSchema>;

/** 送出調價。成本可以留空（代表不動它），售價必填。 */
export const priceChangeSchema = z.object({
  id: z.string().trim().uuid(),
  cost_price: z.number().min(0, "成本不可為負數").finite().nullable(),
  selling_price: z.number().min(0, "售價不可為負數").finite("售價必須是數字"),
});

export type PriceChangeValues = z.infer<typeof priceChangeSchema>;

/** 商品清單的篩選條件。全部下推到資料庫，不在前端 filter。 */
export const productFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  categoryId: z.string().trim().uuid().nullable(),
  productType: z.enum(INV_PRODUCT_TYPES).nullable(),
  vendorId: z.string().trim().uuid().nullable(),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
  activeStatus: z.enum(["all", "active", "inactive"]),
  priceChange: z.enum(["all", "pending"]),
  sort: z.enum([
    "created_at",
    "name_asc",
    "name_desc",
    "issue_asc",
    "issue_desc",
    "stock_asc",
    "stock_desc",
  ]),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type ProductFilterValues = z.infer<typeof productFilterSchema>;

/**
 * Excel 匯入的一列。
 *
 * xlsx 的解析留在瀏覽器（純檔案處理），但解析完的資料一律走這個 schema 進
 * server fn。瀏覽器沒有任何一條路徑碰得到資料庫。
 */
export const importRowSchema = z.object({
  name: z.string().trim().min(1, "商品名稱不可為空").max(200),
  issue_number: z.string().trim().max(50).nullable(),
  barcode: z.string().trim().max(64).nullable(),
  series: z.string().trim().max(200).nullable(),
  publisher: z.string().trim().max(200).nullable(),
  notes: z.string().trim().max(2000).nullable(),
  selling_price: z.number().min(0, "售價不可為負數").finite(),
  cost_price: z.number().min(0, "成本不可為負數").finite().nullable(),
  quantity: z.number().int().min(0),
  /** 前端比對出來的既有商品。server 會再查一次它存不存在，不存在就當成新增。 */
  existing_product_id: z.string().trim().uuid().nullable(),
});

export const importProductsSchema = z.object({
  // 上限與 inv_import_products() 的 IMPORT_TOO_MANY 對齊。
  rows: z.array(importRowSchema).min(1, "沒有要匯入的資料").max(2000, "一次最多 2000 列，請分批"),
  options: z.object({
    create_purchase_record: z.boolean(),
    category_id: z.string().trim().uuid().nullable(),
    product_type: z.enum(INV_PRODUCT_TYPES),
    vendor: z.string().trim().max(200).nullable(),
    purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  }),
});

export type ImportProductsValues = z.infer<typeof importProductsSchema>;
export type ImportRowValues = z.infer<typeof importRowSchema>;

/** 批次調價的三種算法。與 inv.apply_price_op() 的三個 mode 逐字對齊。 */
const priceOpSchema = z.object({
  mode: z.enum(["set", "percent", "amount"]),
  value: z.number().finite("請輸入數字"),
});

export const batchUpdateSchema = z.object({
  ids: z.array(z.string().trim().uuid()).min(1, "沒有選取任何商品").max(500, "一次最多 500 件"),
  patch: z
    .object({
      category_id: z.string().trim().nullable().optional(),
      product_type: z.enum(INV_PRODUCT_TYPES).optional(),
      vendor_id: z.string().trim().nullable().optional(),
      selling_price: priceOpSchema.optional(),
      cost_price: priceOpSchema.optional(),
    })
    .refine((p) => Object.keys(p).length > 0, "請至少選一個要更新的欄位"),
});

export type BatchUpdateValues = z.infer<typeof batchUpdateSchema>;

// ---------------------------------------------------------------------------
// 進貨、庫存盤點、在庫異動（0017）
// ---------------------------------------------------------------------------

/**
 * 在庫異動的六類。與 0017 加的 stock_adjustments_category_check 逐字對齊。
 *
 * ⚠️ 「盤點」不是另一張表，是這裡的 ADJ。0009 搬進來的 inv.inventory_adjustments
 *    是**已凍結的舊表**（30 筆，最後一筆 2026-03-02），新的寫入一筆都不進去。
 *    理由寫在 0017 的檔頭。
 */
export const INV_ADJUSTMENT_CATEGORIES = ["EXP", "PR", "SMP", "INT", "ADJ", "CMB"] as const;
export type InvAdjustmentCategory = (typeof INV_ADJUSTMENT_CATEGORIES)[number];

/** 異動單的四個狀態。與 0017 加的 stock_adjustments_status_check 逐字對齊。 */
export const INV_ADJUSTMENT_STATUSES = [
  "draft",
  "pending_approval",
  "confirmed",
  "rejected",
] as const;
export type InvAdjustmentStatus = (typeof INV_ADJUSTMENT_STATUSES)[number];

/**
 * 盤點差異的六個原因。與 0017 加的 stock_adjustments_reason_check 逐字對齊。
 *
 * 來源把這六個值**串成中文字串塞進 notes**（`盤點調整（盤點誤差）：…`），所以
 * 一年之後沒有人能回答「因為破損少掉幾本」。0017 把它做成真的欄位。
 */
export const INV_ADJUSTMENT_REASONS = [
  "loss",
  "damage",
  "count_error",
  "return",
  "sample",
  "other",
] as const;
export type InvAdjustmentReason = (typeof INV_ADJUSTMENT_REASONS)[number];

/**
 * 一筆進貨。
 *
 * ⚠️ 沒有 approval_status、remaining_quantity、user_id：
 *    · approval_status 由 inv.initial_approval_status('purchases') 在資料庫算
 *    · remaining_quantity 是 FIFO 的消耗欄位，只有 trigger 碰得到
 *    · user_id 取自 middleware 的 context
 *
 * ⚠️ 也沒有折扣／運費／稅金／總額。inv.purchases **沒有這些欄位** —— 小計就是
 *    `quantity × unit_cost`，而且是算出來給人看的，不寫回資料庫。
 */
export const invPurchaseSchema = z.object({
  id: z.string().trim().uuid().nullable().optional(),
  /** 編輯時忽略：換商品等於整批貨搬家，FIFO 批次也要跟著搬。要換就刪掉重開。 */
  product_id: z.string().trim().uuid("請選擇要進貨的商品"),
  item_name: z.string().trim().max(200, "進貨品名最多 200 字").nullable(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  quantity: z
    .number({ invalid_type_error: "數量必須是數字" })
    .int("數量必須是整數")
    .min(1, "數量至少是 1")
    .max(1_000_000, "數量太大了，請確認"),
  unit_cost: z
    .number({ invalid_type_error: "成本必須是數字" })
    .min(0, "成本不可為負數")
    .finite("成本必須是數字")
    .nullable(),
  vendor_id: z.string().trim().uuid().nullable(),
  vendor: z.string().trim().max(200, "供應商名稱最多 200 字").nullable(),
  publisher: z.string().trim().max(200, "出版社最多 200 字").nullable(),
  notes: z.string().trim().max(2000, "備註最多 2000 字").nullable(),
  expiry_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD")
    .nullable(),
  expiry_alert_days: z
    .number({ invalid_type_error: "警示天數必須是數字" })
    .int("警示天數必須是整數")
    .min(1, "警示天數至少是 1")
    .max(365, "警示天數最多 365")
    .nullable(),
});

export type InvPurchaseValues = z.infer<typeof invPurchaseSchema>;

export const purchaseFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  categoryId: z.string().trim().uuid().nullable(),
  vendorId: z.string().trim().uuid().nullable(),
  productType: z.enum(INV_PRODUCT_TYPES).nullable(),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
  /** 效期狀態。與來源的 ?expiry= 五個值逐字一致（Dashboard 的到期提醒會帶進來）。 */
  expiryStatus: z.enum(["all", "expiring", "expired", "warning", "no_expiry"]),
  stockStatus: z.enum(["all", "in_stock", "used_up"]),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  sort: z.enum([
    "purchase_date_desc",
    "purchase_date_asc",
    "created_at",
    "quantity_desc",
    "remaining_asc",
  ]),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type PurchaseFilterValues = z.infer<typeof purchaseFilterSchema>;

/** 批次改供應商／效期。patch 的兩個 key 與 inv_batch_update_purchases 逐字對齊。 */
export const purchaseBatchUpdateSchema = z.object({
  ids: z.array(z.string().trim().uuid()).min(1, "沒有選取任何進貨").max(500, "一次最多 500 筆"),
  patch: z
    .object({
      vendor: z
        .object({
          vendor_id: z.string().trim().uuid().nullable(),
          vendor: z.string().trim().max(200).nullable(),
        })
        .optional(),
      expiry: z
        .object({
          expiry_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable(),
          expiry_alert_days: z.number().int().min(1).max(365).nullable(),
        })
        .optional(),
    })
    .refine((p) => Object.keys(p).length > 0, "請至少選一組要更新的欄位"),
});

export type PurchaseBatchUpdateValues = z.infer<typeof purchaseBatchUpdateSchema>;

const purchaseImportRowSchema = z.object({
  product_id: z.string().trim().uuid().nullable(),
  name: z.string().trim().min(1, "商品名稱不可空白").max(200),
  issue_number: z.string().trim().max(50).nullable(),
  series: z.string().trim().max(200).nullable(),
  barcode: z.string().trim().max(100).nullable(),
  quantity: z.number().int("數量必須是整數").min(1, "數量至少是 1"),
  unit_cost: z.number().min(0, "成本不可為負數").finite().nullable(),
  vendor_id: z.string().trim().uuid().nullable(),
  vendor: z.string().trim().max(200).nullable(),
  purchase_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  notes: z.string().trim().max(2000).nullable(),
  expiry_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  expiry_alert_days: z.number().int().min(1).max(365).nullable(),
  product_type: z.enum(INV_PRODUCT_TYPES).nullable(),
  category_id: z.string().trim().uuid().nullable(),
});

export const importPurchasesSchema = z.object({
  // 上限與 inv_import_purchases() 的 IMPORT_TOO_MANY 對齊。
  rows: z
    .array(purchaseImportRowSchema)
    .min(1, "沒有要匯入的資料")
    .max(2000, "一次最多 2000 列，請分批"),
  options: z.object({
    default_vendor_id: z.string().trim().uuid().nullable(),
    default_category_id: z.string().trim().uuid().nullable(),
    default_purchase_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    default_expiry_alert_days: z.number().int().min(1).max(365).nullable(),
  }),
});

export type ImportPurchasesValues = z.infer<typeof importPurchasesSchema>;

/**
 * 一張在庫異動單。
 *
 * ⚠️ 沒有 status：那是 inv.stock_adjustment_initial_status() 在資料庫算的。來源
 *    的兩支盤點對話框把它硬寫成 'confirmed'，等於審核開關對盤點完全無效 ——
 *    這個 schema 少掉 status 這個欄位，就是那個 bug 在型別上被關起來。
 * ⚠️ 也沒有 unit_cost / total_cost：出庫的成本由 FIFO trigger 算，進庫的用商品
 *    成本。從瀏覽器送成本進來就等於讓人自己填毛利。
 */
export const invAdjustmentSchema = z.object({
  product_id: z.string().trim().uuid("請選擇商品"),
  adjustment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  category: z.enum(INV_ADJUSTMENT_CATEGORIES, { errorMap: () => ({ message: "請選擇異動類別" }) }),
  quantity: z
    .number({ invalid_type_error: "數量必須是數字" })
    .int("數量必須是整數")
    .refine((v) => v !== 0, "異動數量不可為 0") // 鏡射 inv.stock_adjustments 的 non_zero_quantity
    .refine((v) => Math.abs(v) <= 1_000_000, "數量太大了，請確認"),
  reason: z.enum(INV_ADJUSTMENT_REASONS).nullable(),
  notes: z.string().trim().max(2000, "備註最多 2000 字").nullable(),
  /** false = 存成草稿。true = 送出（要不要進待審由資料庫決定）。 */
  submit: z.boolean(),
});

export type InvAdjustmentValues = z.infer<typeof invAdjustmentSchema>;

/**
 * 盤點。
 *
 * ⚠️ 送的是**實盤數量**，不是差異。差異由 inv_record_stock_count() 用當下的
 *    stock_quantity 算 —— 來源在瀏覽器算，店員開著畫面十分鐘、櫃檯中間賣掉三本，
 *    送出的差異就會多扣三本。
 */
export const stockCountSchema = z.object({
  rows: z
    .array(
      z.object({
        product_id: z.string().trim().uuid(),
        actual_quantity: z
          .number({ invalid_type_error: "實際盤點數量必須是數字" })
          .int("數量必須是整數")
          .min(0, "實際盤點數量不可為負數"),
      }),
    )
    .min(1, "沒有要盤點的商品")
    .max(500, "一次最多盤 500 件，請分批"),
  options: z.object({
    reason: z.enum(INV_ADJUSTMENT_REASONS, { errorMap: () => ({ message: "請選擇調整原因" }) }),
    notes: z.string().trim().max(2000).nullable(),
    adjustment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

export type StockCountValues = z.infer<typeof stockCountSchema>;

export const adjustmentFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  category: z.enum(INV_ADJUSTMENT_CATEGORIES).nullable(),
  status: z.enum(["all", ...INV_ADJUSTMENT_STATUSES]),
  productId: z.string().trim().uuid().nullable(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  sort: z.enum(["date_desc", "date_asc", "created_at", "quantity_desc"]),
  page: z.number().int().min(0),
  pageSize: z.number().int().min(1).max(200),
});

export type AdjustmentFilterValues = z.infer<typeof adjustmentFilterSchema>;

// ---------------------------------------------------------------------------
// 套餐（0018）
// ---------------------------------------------------------------------------
// ⚠️ 這裡沒有 approval_status，也沒有 amount / unit_price / cost_price。
//    狀態由 inv.initial_approval_status() 算，金額由 inv.allocate_combo_amounts()
//    分攤 —— payload 裡就算送了這些 key，也沒有任何一行程式會去讀它。
//    來源的 ComboSets.tsx:236 是在瀏覽器算完 approval_status 再連同 insert 送出去。

/** 一件組成品項。同一件商品不可以出現兩次（要多份請改數量）—— 0018 的 COMBO_DUP_ITEM 也擋一次。 */
export const comboItemSchema = z.object({
  product_id: z.string().trim().uuid("請選擇商品"),
  quantity: z
    .number({ invalid_type_error: "數量必須是數字" })
    .int("數量必須是整數")
    .min(1, "數量至少 1")
    .max(999, "數量太多了"),
});

export const comboSetSchema = z.object({
  id: z.string().trim().uuid().nullable(),
  name: z.string().trim().min(1, "請填套餐名稱").max(200),
  selling_price: z
    .number({ invalid_type_error: "組合價必須是數字" })
    .min(0, "組合價不可為負數")
    .finite("組合價必須是數字"),
  notes: z.string().trim().max(2000).nullable(),
  is_active: z.boolean(),
  items: z
    .array(comboItemSchema)
    .min(1, "套餐至少要有一件組成品項")
    .max(50, "組成品項太多了")
    .refine(
      (items) => new Set(items.map((i) => i.product_id)).size === items.length,
      "同一件商品不可以在套餐裡出現兩次，請改用數量",
    ),
});

export type ComboSetValues = z.infer<typeof comboSetSchema>;
export type ComboItemValues = z.infer<typeof comboItemSchema>;

export const comboFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  activeStatus: z.enum(["all", "active", "inactive"]),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
  sort: z.enum(["name_asc", "name_desc", "created_desc", "sold_desc", "price_desc"]),
});

export type ComboFilterValues = z.infer<typeof comboFilterSchema>;

/** 賣一份套餐。呼叫端能決定的只有「哪個套餐、幾份、什麼時候、怎麼付」。 */
export const comboCheckoutSchema = z.object({
  combo_set_id: z.string().trim().uuid("請選擇套餐"),
  quantity: z.number().int().min(1, "至少 1 份").max(100, "一次最多 100 份"),
  sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  payment_method_id: z.string().trim().uuid().nullable(),
  notes: z.string().trim().max(2000).nullable(),
  override_reservation: z.boolean(),
});

export type ComboCheckoutValues = z.infer<typeof comboCheckoutSchema>;

// ---------------------------------------------------------------------------
// 二手書（0018）
// ---------------------------------------------------------------------------
// ⚠️ 沒有 product_id 這個欄位，而且不會有。二手書一本一件、沒有進貨批次、沒有
//    庫存 —— inv.sales 的 CHECK（sales_secondhand_has_no_product）也擋著。
//    「二手商品」這個東西在來源系統裡是 productTypes.ts 的一個幻覺，資料庫從來
//    沒有支援過，0018 把死碼刪掉了。

export const secondhandSaleSchema = z.object({
  item_name: z.string().trim().min(1, "請填書名").max(200),
  quantity: z.number().int().min(1, "數量至少 1").max(999, "數量太多了"),
  unit_price: z
    .number({ invalid_type_error: "售價必須是數字" })
    .min(0, "售價不可為負數")
    .finite("售價必須是數字"),
  sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD"),
  payment_method_id: z.string().trim().uuid().nullable(),
  notes: z.string().trim().max(2000).nullable(),
});

export type SecondhandSaleValues = z.infer<typeof secondhandSaleSchema>;

// ---------------------------------------------------------------------------
// 拍照辨識 OCR（0018）
// ---------------------------------------------------------------------------
// ⚠️ 沒有 base64、沒有 dataUrl、沒有 image 這種欄位。server fn 只收私有 bucket 的
//    storage key，圖是前端先壓縮再上傳的 —— Vercel 的 body 上限大約 4.5MB，而
//    base64 會把圖脹大 33%（來源就是直接把 5.4MB 的 data URL 送進 request body）。

/** `ocr:YYYY-MM-DD/uuid.ext`。形狀在 src/server/storage.ts#ocrObjectName 再驗一次。 */
export const ocrScanKeySchema = z
  .string()
  .trim()
  .regex(/^ocr:\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(webp|jpg|png)$/, "掃描圖代碼不正確");

export const ocrRecogniseSchema = z.object({
  scan_key: ocrScanKeySchema,
});

export type OcrRecogniseValues = z.infer<typeof ocrRecogniseSchema>;

/** 辨識失敗的分類。與 src/server/gemini.ts 的 OcrFailureKind 逐字對齊。 */
export const OCR_FAILURE_KINDS = [
  "quota",
  "timeout",
  "bad_response",
  "no_content",
  "service",
] as const;

export type OcrFailureKindValue = (typeof OCR_FAILURE_KINDS)[number];

// ---------------------------------------------------------------------------
// 三語欄位的自動翻譯
// ---------------------------------------------------------------------------
// ⚠️ 只收一段中文，不收欄位名、不收語言選項、不收 model 名稱。要翻成哪兩種語言是
//    這個網站的事實（jsonb 的 zh/en/ja 三個 key），不是瀏覽器可以指定的參數；模型
//    更是只能從 GEMINI_TRANSLATE_MODEL 來，讓 client 送等於讓人挑一個貴的來燒額度。

export const translateSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "請先填中文，再按自動翻譯")
    // 與 src/server/translate.ts 的 MAX_INPUT_CHARS 同一個數字。這裡擋在進門，
    // 那裡再切一次 —— 兩層都留著，因為 server fn 不是唯一可能的呼叫端。
    .max(2000, "文字太長，請分段翻譯"),
});

export type TranslateValues = z.infer<typeof translateSchema>;

/**
 * 翻譯失敗的分類。與 src/server/translate.ts 的 TranslateFailureKind 逐字對齊。
 *
 * ⚠️ **刻意不共用 OCR_FAILURE_KINDS**，雖然現在兩邊剛好是同五個字。它們對到的是
 *    兩組完全不同的畫面文案（辨識失敗說「重拍」，翻譯失敗說「自己填英日文」），
 *    共用一個陣列的意思是「哪天其中一邊要多一種 kind，另一邊的 UI 會跟著多出一個
 *    沒有人寫過文案的分支」。
 */
export const TRANSLATE_FAILURE_KINDS = [
  "quota",
  "timeout",
  "bad_response",
  "no_content",
  "service",
] as const;

export type TranslateFailureKindValue = (typeof TRANSLATE_FAILURE_KINDS)[number];

// ---------------------------------------------------------------------------
// 廠商（0019）
// ---------------------------------------------------------------------------
// ⚠️ 這裡沒有 approval_status、approved_by、created_by、vendor_code，而且不會有。
//    四個全部由資料庫決定（0019 §5.1），payload 裡就算送了也沒有一行程式會讀。
//    來源的 VendorFormDialog.tsx:266 是
//    `{ ...payload, created_by: user!.id, approval_status: getInitialApprovalStatus('vendors') }`
//    —— 那三樣東西全部由瀏覽器說了算，而 DB 沒有任何 trigger 或 CHECK 攔它。
//
// ⚠️ 下面每一個 enum 都是 inv.vendors 那幾條 CHECK 的鏡射。**資料庫那一份才是
//    值域**，這裡只是為了讓錯誤在送出之前就講中文。兩邊不一致時以資料庫為準
//    （selftest 會逐個比對）。

export const VENDOR_ENTITY_TYPES = [
  "domestic_company",
  "domestic_individual",
  "foreign",
  "foreign_individual",
] as const;

export const VENDOR_ENTITY_TYPE_LABELS: Record<(typeof VENDOR_ENTITY_TYPES)[number], string> = {
  domestic_company: "國內公司",
  domestic_individual: "國內個人",
  foreign: "國外法人",
  foreign_individual: "國外個人",
};

export const VENDOR_STATUSES = ["active", "suspended", "inactive"] as const;
export const VENDOR_STATUS_LABELS: Record<(typeof VENDOR_STATUSES)[number], string> = {
  active: "往來中",
  suspended: "暫停往來",
  inactive: "已終止",
};

export const VENDOR_VOUCHER_CATEGORIES = [
  "invoice",
  "receipt",
  "official_document",
  "labor_payment",
  "none",
] as const;
export const VENDOR_EINVOICE_TYPES = ["none", "b2b", "b2c"] as const;
export const VENDOR_PAYMENT_TERMS = ["immediate", "monthly", "negotiated"] as const;
export const VENDOR_SETTLEMENT_TYPES = ["invoice_date", "end_of_month", "monthly"] as const;
export const VENDOR_RESIDENCY_STATUSES = ["over_183", "under_183"] as const;

/** 0–1 的小數。畫面上填的是百分比，換算在表單元件裡；值域在這裡與 inv.assert_rate() 各守一次。 */
const rateSchema = z
  .number({ invalid_type_error: "費率必須是數字" })
  .min(0, "費率不可為負數")
  .max(1, "費率不可超過 100%")
  .finite("費率必須是數字")
  .nullable();

/** 1–31。來源只有 HTML 的 min/max，改一個 request body 就過，而 DB 也沒有 CHECK。 */
const dayOfMonthSchema = z
  .number({ invalid_type_error: "日期必須是數字" })
  .int("日期必須是整數")
  .min(1, "日期必須介於 1 與 31")
  .max(31, "日期必須介於 1 與 31")
  .nullable();

const trimmedNullable = (max: number) => z.string().trim().max(max).nullable();

export const vendorSchema = z
  .object({
    id: z.string().trim().uuid().nullable(),

    // 分頁一：基本 + 識別
    entity_type: z.enum(VENDOR_ENTITY_TYPES),
    category_id: z.string().trim().uuid().nullable(),
    name: z.string().trim().min(1, "請填供應商名稱").max(200),
    name_en: trimmedNullable(200),
    short_name: trimmedNullable(100),
    representative: trimmedNullable(100),
    is_preferred: z.boolean(),
    notes: trimmedNullable(2000),
    tax_id: trimmedNullable(20),
    id_number: trimmedNullable(20),
    foreign_id: trimmedNullable(50),
    foreign_id_type: trimmedNullable(100),
    residence_permit_number: trimmedNullable(50),
    taiwan_residency_status: z.enum(VENDOR_RESIDENCY_STATUSES).nullable(),
    country_code: trimmedNullable(3),

    // 分頁二：聯絡
    phone: trimmedNullable(50),
    fax: trimmedNullable(50),
    email: z
      .union([z.literal(""), z.string().trim().email("電子郵件格式不正確").max(200)])
      .nullable(),
    address: trimmedNullable(500),
    address_en: trimmedNullable(500),
    invoice_address: trimmedNullable(500),

    // 分頁三：財務 + 寄售抽成
    default_tax_type_id: z.string().trim().uuid().nullable(),
    default_withholding_category_id: z.string().trim().uuid().nullable(),
    is_nhi_applicable: z.boolean(),
    voucher_category: z.enum(VENDOR_VOUCHER_CATEGORIES),
    einvoice_type: z.enum(VENDOR_EINVOICE_TYPES),
    payment_terms: z.enum(VENDOR_PAYMENT_TERMS),
    payment_terms_note: trimmedNullable(500),
    settlement_type: z.enum(VENDOR_SETTLEMENT_TYPES),
    settlement_start_day: dayOfMonthSchema,
    settlement_interval_days: z.number().int().min(0).max(365).nullable(),
    bill_due_day: dayOfMonthSchema,
    is_consignment: z.boolean(),
    cash_fee_rate: rateSchema,
    domestic_card_fee_rate: rateSchema,
    foreign_card_fee_rate: rateSchema,
    commission_rate: rateSchema,

    status: z.enum(VENDOR_STATUSES),
  })
  // 識別碼依實體類型必填。**這是 inv_save_vendor() 那四個 RAISE 的鏡射** —— 兩邊
  // 都要有：這裡讓錯誤出現在對的欄位旁邊，資料庫那邊擋直接 POST 的。
  .refine((v) => v.entity_type !== "domestic_company" || !!v.tax_id?.trim(), {
    message: "國內公司必須填統一編號",
    path: ["tax_id"],
  })
  .refine((v) => v.entity_type !== "domestic_individual" || !!v.id_number?.trim(), {
    message: "國內個人必須填身分證字號",
    path: ["id_number"],
  })
  .refine((v) => v.entity_type !== "foreign" || !!v.foreign_id?.trim(), {
    message: "國外法人必須填國外識別碼",
    path: ["foreign_id"],
  })
  .refine(
    (v) =>
      v.entity_type !== "foreign_individual" ||
      !!v.foreign_id?.trim() ||
      !!v.residence_permit_number?.trim(),
    { message: "國外個人必須填國外識別碼或居留證號碼", path: ["foreign_id"] },
  );

export type VendorValues = z.infer<typeof vendorSchema>;

export const vendorFilterSchema = z.object({
  keyword: z.string().trim().max(100).nullable(),
  entityType: z.enum(["all", ...VENDOR_ENTITY_TYPES]),
  consignment: z.enum(["all", "yes", "no"]),
  status: z.enum(["all", ...VENDOR_STATUSES]),
  approvalStatus: z.enum(["all", "pending", "approved", "rejected"]),
  sort: z.enum(["name_asc", "name_desc", "code_asc", "created_desc", "products_desc"]),
});

export type VendorFilterValues = z.infer<typeof vendorFilterSchema>;

export const vendorBankAccountSchema = z.object({
  id: z.string().trim().uuid().nullable(),
  account_holder_name: z.string().trim().min(1, "請填戶名").max(100),
  bank_code: z.string().trim().min(1, "請填銀行代碼").max(5),
  bank_name: z.string().trim().min(1, "請填銀行名稱").max(100),
  branch_code: trimmedNullable(10),
  branch_name: trimmedNullable(100),
  account_number: z.string().trim().min(1, "請填帳號").max(50),
  account_purpose: trimmedNullable(100),
  is_default: z.boolean(),
  notes: trimmedNullable(500),
  sort_order: z.number().int().min(0).max(999),
});

export type VendorBankAccountValues = z.infer<typeof vendorBankAccountSchema>;

export const vendorContactSchema = z.object({
  id: z.string().trim().uuid().nullable(),
  name: z.string().trim().min(1, "請填聯絡人姓名").max(100),
  job_title: trimmedNullable(100),
  phone: trimmedNullable(50),
  mobile: trimmedNullable(50),
  email: z
    .union([z.literal(""), z.string().trim().email("電子郵件格式不正確").max(200)])
    .nullable(),
  is_primary: z.boolean(),
  is_finance_contact: z.boolean(),
  notes: trimmedNullable(500),
  sort_order: z.number().int().min(0).max(999),
});

export type VendorContactValues = z.infer<typeof vendorContactSchema>;

export const VENDOR_ATTACHMENT_TYPES = ["general", "contract"] as const;

export const vendorAttachmentSchema = z.object({
  file_name: z.string().trim().min(1).max(300),
  // `vendorfile:<vendor uuid>/<uuid>.<ext>` —— 形狀在 storage.ts#vendorAttachmentObjectName
  // 再驗一次（那裡才是路徑穿越的防線）。
  file_path: z.string().trim().min(1).max(500),
  file_type: z.string().trim().min(1).max(200),
  file_size: z
    .number()
    .int()
    .min(0)
    .max(20 * 1024 * 1024)
    .nullable(),
  description: trimmedNullable(500),
  attachment_type: z.enum(VENDOR_ATTACHMENT_TYPES),
  contract_start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  contract_end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  contract_version: trimmedNullable(50),
  is_current: z.boolean(),
});

export type VendorAttachmentValues = z.infer<typeof vendorAttachmentSchema>;

// ---------------------------------------------------------------------------
// PII 查閱（0019 §4）
// ---------------------------------------------------------------------------
// ⚠️ fields 是白名單，而且**沒有 "*" 或 "all"**。想一次看全部就得把五個名字都列
//    出來，而那筆稽核紀錄就會長成「這個人一次看了五個欄位」—— 那正是稽核要看見
//    的形狀。0019 §4.2 的 v_allowed 是同一份清單。
// ⚠️ reason 是列舉不是自由文字。自由文字最後一定變成空字串。

export const VENDOR_SENSITIVE_FIELDS = [
  "tax_id",
  "id_number",
  "foreign_id",
  "residence_permit_number",
  "bank_accounts",
] as const;

export const VENDOR_SENSITIVE_FIELD_LABELS: Record<
  (typeof VENDOR_SENSITIVE_FIELDS)[number],
  string
> = {
  tax_id: "統一編號",
  id_number: "身分證字號",
  foreign_id: "國外識別碼",
  residence_permit_number: "居留證號碼",
  bank_accounts: "匯款帳戶",
};

/**
 * **廠商那一側**的查閱事由。
 *
 * ⚠️ 這不是 pii_access_log.reason 的完整值域。0021 §1 把那條 CHECK 放寬到七種，
 *    多出來的兩種（attendee_contact / roster_export）是名單那一側的，見下面的
 *    ROSTER_ACCESS_REASONS。兩份清單刻意分開，因為 VendorSensitiveDialog 的下拉
 *    選單是直接 map 這一份 —— 合成一份的話，店員查廠商時就會看到「匯出報名名單」
 *    這個選項，而那會產生一筆語意錯誤而且刪不掉的稽核紀錄。
 */
export const PII_ACCESS_REASONS = [
  "reconciliation",
  "payment",
  "tax_filing",
  "vendor_enquiry",
  "self_service",
] as const;

export const PII_ACCESS_REASON_LABELS: Record<(typeof PII_ACCESS_REASONS)[number], string> = {
  reconciliation: "對帳",
  payment: "匯款作業",
  tax_filing: "報稅／扣繳申報",
  vendor_enquiry: "廠商來電查詢",
  self_service: "廠商自助入口",
};

/**
 * **名單那一側**的查閱事由（0021 §1）。
 *
 * ⚠️ 與上面那五種有一個結構上的差別：這兩種**不是使用者挑的**，是由動作決定的。
 *    按「顯示完整聯絡方式」永遠是 attendee_contact，按「匯出 CSV」永遠是
 *    roster_export。名單只有這兩種看法，讓店員從一個永遠只有一個正確答案的下拉
 *    選單裡挑，得到的不是資訊而是雜訊。
 *
 *    所以這裡沒有對應的 zod schema，也沒有任何 server fn 收 reason 參數 ——
 *    這份清單只給畫面用（告訴使用者這次會以什麼事由留下紀錄）。
 */
export const ROSTER_ACCESS_REASONS = ["attendee_contact", "roster_export"] as const;

export const ROSTER_ACCESS_REASON_LABELS: Record<(typeof ROSTER_ACCESS_REASONS)[number], string> = {
  attendee_contact: "查看參加者聯絡方式",
  roster_export: "匯出報名名單",
};

export const vendorSensitiveRequestSchema = z.object({
  vendor_id: z.string().trim().uuid("請選擇廠商"),
  fields: z
    .array(z.enum(VENDOR_SENSITIVE_FIELDS))
    .min(1, "請選擇要查看哪些欄位")
    .max(VENDOR_SENSITIVE_FIELDS.length),
  // self_service 只由廠商入口那一側自己帶，店員這一側選不到（UI 不列它，
  // server fn 也會擋 —— 見 fns/inv-vendors.ts）。
  reason: z.enum(PII_ACCESS_REASONS),
});

export type VendorSensitiveRequestValues = z.infer<typeof vendorSensitiveRequestSchema>;

export const piiAccessLogFilterSchema = z.object({
  vendorId: z.string().trim().uuid().nullable(),
  actorUserId: z.string().trim().uuid().nullable(),
  limit: z.number().int().min(1).max(500),
});

// ---------------------------------------------------------------------------
// 廠商自助入口（0019 §7）
// ---------------------------------------------------------------------------
// ⚠️ **這一段的每一個 schema 都沒有 vendor_id 欄位，而且不可以有。** 過濾用的
//    vendor_id 一律來自 session（context.vendor.vendorId），資料庫那一側的函式
//    簽名也沒有 p_vendor_id 參數。selftest 會掃這個檔案確認這一條。
// ⚠️ 也沒有 approval_status / stock_quantity / cost_price / product_type：
//    四個全部由資料庫決定，廠商送了也不會被讀（0019 §7.7）。

export const vendorSignInSchema = z.object({
  email: z.string().trim().email("電子郵件格式不正確").max(200),
  password: z.string().min(1, "請輸入密碼").max(200),
});

export const vendorProductSubmitSchema = z.object({
  id: z.string().trim().uuid().nullable(),
  name: z.string().trim().min(1, "請填商品名稱").max(200),
  issue_number: trimmedNullable(50),
  series: trimmedNullable(100),
  publisher: trimmedNullable(100),
  barcode: trimmedNullable(50),
  notes: trimmedNullable(2000),
  image_key: trimmedNullable(300),
  selling_price: z
    .number({ invalid_type_error: "建議售價必須是數字" })
    .min(0, "建議售價不可為負數")
    .max(1_000_000, "建議售價太高了")
    .finite("建議售價必須是數字"),
});

export type VendorProductSubmitValues = z.infer<typeof vendorProductSubmitSchema>;

/** 核准廠商送審的商品，可選同時上架。三語文案由**店員**填，廠商送不進來。 */
export const vendorSubmissionApprovalSchema = z.object({
  id: z.string().trim().uuid(),
  approved: z.boolean(),
  listing: z
    .object({
      slug: z
        .string()
        .trim()
        .min(1, "請填網址代稱")
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "網址代稱只能用小寫英數字與連字號"),
      product_type: z.enum(["goods", "book"]),
      title: localizedSchema,
      summary: localizedSchema,
      description: localizedSchema,
      price: z.number().int().min(0, "定價不可為負數"),
      units_per_sale: z.number().int().min(1).max(999),
      image_key: trimmedNullable(300),
      status: z.enum(["draft", "active"]),
    })
    .nullable(),
});

export type VendorSubmissionApprovalValues = z.infer<typeof vendorSubmissionApprovalSchema>;

// ---------------------------------------------------------------------------
// 後台人員管理（/admin/staff，supabase/migrations/0033_admin_staff_management.sql）
// ---------------------------------------------------------------------------
// STAFF_PERMISSIONS 在這裡重新宣告一份，不是從 @/server/auth import 那份同名
// 常數——那個檔案第一行是 `import "@tanstack/react-start/server-only"`，瀏覽器
// import 它會直接炸掉，而 schemas.ts 是 route 元件（瀏覽器端）也會 import 的
// 檔案（例如 _shell.categories.tsx 就 import 這裡的 eventCategorySchema）。
// 這不是這個檔案第一次這樣做：VENDOR_SENSITIVE_FIELDS 在上面（本檔案）與
// src/server/repos/inv-vendors.ts 也是各自宣告一份，同一個跨界限制、同一個
// 解法，這裡照抄既有做法。九個值必須與 src/server/auth.ts 的 STAFF_PERMISSIONS
// 逐字一致——它們同時也必須是 public.staff_permissions.permission 的 CHECK
// 值域（0021 §4）的子集，那條 CHECK 才是真正的權威來源。

export const STAFF_PERMISSIONS = [
  "approve_products",
  "approve_purchases",
  "approve_price_changes",
  "approve_vendors",
  "approve_combo_sets",
  "approve_stock_adjustments",
  "approve_inventory_adjustments",
  "inv.vendor.pii.read",
  "event.roster.read",
] as const;

/**
 * 建立新帳號時允許設定的角色。🔴 刻意只有這三種，不可以是 vendor 或
 * customer——vendor 是廠商自助入口（0019）的身分，customer 是一般購物客人，
 * 兩者都不是「後台人員」。這份清單與 src/server/repos/staff-accounts.ts 的
 * CreatableRole 型別、supabase/migrations/0033_admin_staff_management.sql §2
 * 的 RPC 內部檢查，三處刻意各自寫死同一份三值清單而不共用一個型別——同一個
 * server-only / 瀏覽器端的跨界限制，見上面 STAFF_PERMISSIONS 的說明。
 */
export const CREATABLE_BACKOFFICE_ROLES = ["pending", "staff", "admin"] as const;

export const createStaffAccountSchema = z.object({
  email: z.string().trim().email("電子郵件格式不正確").max(200),
  // 8：Supabase 專案目前設定的密碼長度下限（見任務交代，非這裡發明的規則）。
  // 這裡驗證是為了在畫面上給出即時、友善的錯誤，真正的下限仍由 GoTrue 自己
  // 的專案設定把關——即使這裡被繞過（直接呼叫 server fn），GoTrue 也會拒絕。
  password: z.string().min(8, "密碼至少需要 8 個字元").max(200, "密碼太長了"),
  role: z.enum(CREATABLE_BACKOFFICE_ROLES, { errorMap: () => ({ message: "請選擇角色" }) }),
});

export type CreateStaffAccountValues = z.infer<typeof createStaffAccountSchema>;

export const updateStaffRoleSchema = z.object({
  userId: z.string().trim().uuid(),
  role: z.enum(CREATABLE_BACKOFFICE_ROLES, { errorMap: () => ({ message: "請選擇角色" }) }),
});

export type UpdateStaffRoleValues = z.infer<typeof updateStaffRoleSchema>;

/**
 * 移除後台身分。⚠️ 刻意沒有 role 欄位——這個動作永遠把角色設回 'customer'，
 * 那個值由 server fn 自己決定（src/lib/admin/fns/staff-accounts.ts 的
 * removeStaffAccess），這支 schema 從協定層面就沒有地方可以夾帶任何角色值。
 */
export const removeStaffAccessSchema = z.object({
  userId: z.string().trim().uuid(),
});

export type RemoveStaffAccessValues = z.infer<typeof removeStaffAccessSchema>;

export const staffPermissionsSchema = z.object({
  userId: z.string().trim().uuid(),
  permissions: z.array(z.enum(STAFF_PERMISSIONS)).max(STAFF_PERMISSIONS.length),
});

export type StaffPermissionsValues = z.infer<typeof staffPermissionsSchema>;
