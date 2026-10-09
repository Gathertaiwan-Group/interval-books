/**
 * 活動頁「組裝器」——一場活動的內容，由上到下組成一頁。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 這一頁在做什麼
 * ═══════════════════════════════════════════════════════════════════════════
 * 店家要能像組裝一頁那樣編一場活動：**後台段落由上到下的順序，就是前台區塊的順序；
 * 某一段留空，前台那一整塊就消失。** 留空是「關掉」，不是「還沒填」（0027 把七個清單
 * 欄位設成 not null default 三個空陣列，就是為了讓這句話在資料層也成立）。
 *
 * 原本這一切住在 /admin/events 的一個十一欄 Dialog 裡。Dialog 塞不下這個形狀 ——
 * 它沒有「上下順序」這個概念，也沒有地方放「這一段留空前台就不畫」這種說明。所以拆成
 * 列表頁（_shell.events.tsx）＋ 這一支獨立的組裝器路由，形狀照抄 repo 既有的先例
 * `_shell.pages.tsx` + `_shell.pages.$slug.tsx`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 段號 1–11 從第一天就連號
 * ═══════════════════════════════════════════════════════════════════════════
 * D3 那一期只做得完七段（固定欄位那幾段），場次與三種可重複區塊還是 placeholder，
 * 但段號**從第一天就排到 11**：「第 6 段」這個講法會立刻進到店家與客服的對話裡
 * （「你到第 6 段看一下」），等後面幾期把場次插進來才重排編號，那些對話全部作廢，
 * 而且沒有任何東西會提醒任何人。
 *
 * D4 把那四段填成真的（§3 場次、§5 agenda、§8 info_row、§9 faq），**段號一個都沒動** ——
 * 那正是先佔號要換到的東西。現在 11 段全部是真的，沒有 placeholder 了。
 *
 * 🔴 **段號由 nextStep() 在畫面上那個位置求值，所以輔助 render 一定要是「函式」，
 *    不可以是 `const Foo = (<Section step={nextStep()} …/>)`。** 寫成 const 的那一刻，
 *    那個 JSX 在元件本體執行到那一行時就先領走了一個編號，於是它後面的每一段都往後
 *    退一號 —— 來源專案就是這樣讓整頁從第 10 段開始的，而他們當時只有一句註解守著。
 *    這一版另外有 scripts/event-assembler-selftest.mjs 用 AST 掃這個形狀。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 六個一定會踩到的雷（每一個都在下面的程式碼裡有對應的註解）
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. 主儲存之後**不可以** bump formKey（見 handleValid 上面那一段）。
 *  2. 巢狀 FormProvider —— 主表單是一個**空的隱藏 <form>**，儲存鈕靠 form= 屬性歸隊；
 *     每一個區塊編輯器內部**再開一層** <Form {...blockForm}>（做在
 *     src/components/admin/EventBlockEditor.tsx，理由寫在那個檔案的檔頭）。
 *  3. handleSubmit 一定要傳第二個參數 onInvalid（見 handleInvalid）。
 *  4. 段號要在畫面上那個位置求值（見上一段）。
 *  5. ImageField 不可以包在 <FormControl> 裡（見 §1 的圖片欄位）。
 *  6. 髒狀態防護分三層（見 dirty / useBlocker / sticky bar）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  createFileRoute,
  Link,
  notFound,
  useBlocker,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import type { FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { LocalizedListField } from "@/components/admin/LocalizedListField";
import { GalleryField } from "@/components/admin/GalleryField";
import { ImageField } from "@/components/admin/ImageField";
import { MirrorNote } from "@/components/admin/MirrorNote";
import { EventBlockEditor, type EventBlockItem } from "@/components/admin/EventBlockEditor";
import { eventReading } from "@/lib/images";
import { formatTaipeiDateTime } from "@/lib/taipei-time";
import { EVENT_BLOCK_KINDS, EVENT_LIST_FIELDS, type EventBlockKind } from "@/lib/event-blocks";
import { EVENT_BLOCK_COPY } from "@/lib/admin/event-block-copy";
import { linesToList, listToLines } from "@/lib/admin/localized-list";
import { collectErrorPaths, invalidToastMessage } from "@/lib/admin/form-errors";
import {
  dirtyBannerText,
  dirtyKeys,
  hasDirty,
  markDirty,
  type DirtyState,
} from "@/lib/admin/dirty-sections";
import {
  eventProductSchema,
  eventSchema,
  optionalLocalizedLinesFormSchema,
  type EventWithProductFormValues,
} from "@/lib/admin/schemas";
import type { getEventById, listEventProducts, listSessionsForEvent } from "@/lib/admin/fns/events";
import type { listEventBlocks } from "@/lib/admin/fns/event-blocks";
import type { listEventCategories } from "@/lib/admin/fns/event-categories";
import type { listArtistOptions } from "@/lib/admin/fns/artists";
import type { Localized } from "@/i18n/types";

type EventRow = NonNullable<Awaited<ReturnType<typeof getEventById>>>;
type EventProductRow = Awaited<ReturnType<typeof listEventProducts>>[string];
type EventCategoryRow = Awaited<ReturnType<typeof listEventCategories>>[number];
type ArtistOption = Awaited<ReturnType<typeof listArtistOptions>>[number];
type SessionBrief = Awaited<ReturnType<typeof listSessionsForEvent>>[number];
type BlockRow = Awaited<ReturnType<typeof listEventBlocks>>[number];

/** §3 的場次狀態。與 /admin/registrations 的 STATUS_LABEL 同一組字。 */
const SESSION_STATUS_LABEL: Record<string, string> = {
  open: "開放報名",
  closed: "未開放",
};

const EMPTY_LOCALIZED: Localized = { zh: "", en: "", ja: "" };
const EMPTY_LINES = { zh: "", en: "", ja: "" };

/**
 * Radix 的 <SelectItem> 不接受 value=""（空字串是「沒有選任何東西」的內部狀態）。
 * 「不指定主講人」用哨兵值，送出前再換回 null。與舊的 Dialog 同一條規則。
 */
const NO_SPEAKER = "__none__";

/**
 * 「還沒建立」的那一場活動，網址是 /admin/events/new。
 *
 * ⚠️ 這是一個哨兵值，不是一個真的 id。它安全，因為 events.id 只有兩個產生器
 *    （src/server/repos/events.ts 的 randomUUID() 與 0027 RPC 裡的 gen_random_uuid()），
 *    兩個都產不出 "new"，而後台沒有任何地方讓人自己指定 id。
 *
 * 為什麼不做成第二個路由檔（_shell.events.new.tsx）：那樣會有兩支路由共用同一份表單，
 * 而這一頁存在的理由就是「固定欄位只有一個家」。新增與編輯是同一頁，差別只有
 * 「載不載得到舊資料」。
 */
const NEW_EVENT_ID = "new";

/**
 * §5／§8／§9 在「還沒建立的活動」上顯示的那一句。
 *
 * event_blocks.event_id 是 `references public.events (id)`（0027），所以段落掛不上
 * 一場還不存在的活動。這裡刻意講清楚「先按新增活動」，而不是畫一個按了會噴外鍵錯誤
 * 的編輯器。
 */
const NEW_EVENT_BLOCK_NOTE =
  "先按下面的「新增活動」把這場活動建立起來，才能加段落——段落掛在活動的 id 上，而這場活動還沒有 id。";

/**
 * 主表單那個**空的隱藏 <form>** 的 id。
 *
 * 🔴 HTML 的 <form> 不能巢狀。這一頁未來每一個區塊編輯器都要有自己的 <form>（它們
 *    各自送出、各自驗證），所以主表單**不可以**用一個 <form> 把整頁包起來 —— 包起來
 *    的那一刻，區塊編輯器的 <form> 就只能是它的子孫，而瀏覽器會把巢狀的 form 直接
 *    丟掉（不是報錯，是安靜地丟掉，於是內層的送出鈕會去送外層的表單）。
 *
 *    做法：主表單放一個空的、隱藏的 <form id={CONTENT_FORM_ID}>，儲存鈕用
 *    `form={CONTENT_FORM_ID}` 屬性歸隊。欄位本身是 react-hook-form 註冊的，不靠
 *    DOM 的 form 關聯，所以驗證與取值完全不受影響。
 *
 * ⚠️ 副作用（刻意接受）：欄位不在 <form> 裡，所以在單行輸入框按 Enter **不會**送出。
 *    對一頁十一段的表單來說，這件事是好的。
 */
const CONTENT_FORM_ID = "event-content";

/** 主表單（固定欄位那幾段）在髒狀態登記簿上的 key。 */
const MAIN_SECTION_KEY = "content";

/** 一種區塊在髒狀態登記簿上的 key。三種各一個，所以 sticky bar 講得出是哪一段。 */
const blockSectionKey = (kind: EventBlockKind) => `block:${kind}`;

/**
 * 登記簿的 key → 畫面上講得出口的名字。
 *
 * ⚠️ 三種區塊的名字從 EVENT_BLOCK_COPY 來，不是在這裡再打一次「活動流程」「資訊列」
 *    「常見問答」。抄第二份的下場是段落改名之後 sticky bar 還在講舊名字，而那正是
 *    使用者唯一會看到的那一句話。
 */
const SECTION_LABELS: Record<string, string> = {
  [MAIN_SECTION_KEY]: "活動內容",
  ...Object.fromEntries(
    EVENT_BLOCK_KINDS.map((k) => [blockSectionKey(k), EVENT_BLOCK_COPY[k].sectionTitle]),
  ),
};

const PRODUCT_STATUS_LABEL: Record<"draft" | "active" | "archived", string> = {
  draft: "草稿",
  active: "已上架",
  archived: "已下架",
};

const REGISTRATION_TYPE_LABEL: Record<"external" | "internal", string> = {
  external: "外部連結報名",
  internal: "站內報名",
};

/**
 * 表單的形狀。
 *
 * 固定欄位沿用 eventSchema（＝ server fn 的門），商品沿用 eventProductSchema。
 * 七個清單欄位在**表單上是三個 textarea 的原始字串**，不是三個陣列 —— 送出前才用
 * linesToList() 換過去（見 handleValid）。這一對是明著配對的兩支 schema，理由寫在
 * src/lib/admin/schemas.ts 的「可以整組留空的三語清單」那一段。
 */
function buildAssemblerFormSchema() {
  return eventSchema.extend({
    product: eventProductSchema.nullable().optional(),
    highlights: optionalLocalizedLinesFormSchema,
    suitable_for: optionalLocalizedLinesFormSchema,
    not_suitable_for: optionalLocalizedLinesFormSchema,
    takeaways: optionalLocalizedLinesFormSchema,
    outline: optionalLocalizedLinesFormSchema,
    includes: optionalLocalizedLinesFormSchema,
    notes: optionalLocalizedLinesFormSchema,
  });
}
type AssemblerFormShape = z.infer<ReturnType<typeof buildAssemblerFormSchema>>;

/**
 * 送出去的那七欄（三個 string[]，不是三個字串）。
 *
 * ⚠️ 這個型別要**具名**，不可以讓它停在 Object.fromEntries() 推出來的
 *    `Record<string, …>`：帶索引簽章的物件展開在固定欄位後面時，TypeScript 不會
 *    認為它覆蓋掉了同名的固定欄位 —— 於是「表單的字串」與「要送出的陣列」哪一個
 *    贏，會變成一件靠執行期決定的事。這裡釘成具名型別，是為了讓那個覆蓋是型別
 *    層面成立的。
 */
type EventListPayload = Required<
  Pick<EventWithProductFormValues, (typeof EVENT_LIST_FIELDS)[number]>
>;

/** 驗證失敗時 toast 要說得出口的欄位名。找不到對照會退回欄位路徑，不會被丟掉。 */
const FIELD_LABELS: Record<string, string> = {
  title: "§2 標題",
  summary: "§2 摘要",
  description: "§2 說明",
  slug: "§1 網址代稱",
  display_date: "§1 顯示用日期",
  iso_date: "§1 標準日期",
  category: "§1 分類",
  speaker_id: "§1 主講人",
  image_key: "§1 活動圖片",
  gallery_keys: "§1 活動相簿",
  sort_order: "§1 排序",
  external_url: "§4 報名／活動網址",
  registration_type: "§4 報名方式",
  payment_enabled: "§4 需付款",
  show_seats_remaining: "§4 名額顯示",
  product: "§4 商品",
  "product.price": "§4 售價",
  "product.compare_at_price": "§4 原價",
  "product.status": "§4 商品狀態",
  highlights: "§6 活動亮點",
  takeaways: "§6 帶得走什麼",
  suitable_for: "§7 適合對象",
  not_suitable_for: "§7 不適合對象",
  outline: "§10 流程大綱",
  includes: "§10 費用包含",
  notes: "§11 注意事項",
};

/**
 * §4 那個名額開關的說明文字。
 *
 * 抽成常數而不是直接寫在 JSX 裡：它比一行長，寫在 <FormDescription> 裡會被 prettier
 * 折成三行，而 JSX 的換行會在中文字之間留下一個看得見的空格（「留著， 「尚餘名額」）。
 */
const SEATS_VISIBILITY_HINT =
  "名額設得很寬鬆（等於不限）時建議關掉 —— 畫面上印出「尚餘名額 999」對客人不是資訊。" +
  "名額真的緊的時候留著，「尚餘名額 2」會影響他報不報名。";

/** 清單欄位：資料庫的三個陣列 → 表單的三個「一行一項」字串。 */
function listToForm(value: { zh: string[]; en: string[]; ja: string[] } | null | undefined) {
  if (!value) return { ...EMPTY_LINES };
  return {
    zh: listToLines(value.zh ?? []),
    en: listToLines(value.en ?? []),
    ja: listToLines(value.ja ?? []),
  };
}

function toFormValues(
  row: EventRow | null,
  product: EventProductRow | undefined,
  nextSortOrder: number,
): AssemblerFormShape {
  const lists = Object.fromEntries(
    EVENT_LIST_FIELDS.map((f) => [f, listToForm(row ? row[f] : null)]),
  ) as Pick<AssemblerFormShape, (typeof EVENT_LIST_FIELDS)[number]>;

  return {
    ...lists,
    id: row?.id,
    slug: row?.slug ?? "",
    image_key: row?.image_key ?? null,
    gallery_keys: row?.gallery_keys ?? [],
    title: row?.title ?? { ...EMPTY_LOCALIZED },
    summary: row?.summary ?? { ...EMPTY_LOCALIZED },
    description: row?.description ?? { ...EMPTY_LOCALIZED },
    display_date: row?.display_date ?? "",
    iso_date: row?.iso_date ?? "",
    category: row?.category ?? "",
    speaker_id: row?.speaker_id ?? null,
    external_url: row?.external_url ?? "",
    registration_type: row?.registration_type ?? "external",
    payment_enabled: row?.payment_enabled ?? false,
    // 0029。新增的活動預設**顯示**（＝ 欄位預設，也是 0029 之前的行為）——
    // 關掉名額顯示要是店家的一個明確動作，不是一個安靜的初始值。
    show_seats_remaining: row?.show_seats_remaining ?? true,
    is_published: row?.is_published ?? true,
    sort_order: row?.sort_order ?? nextSortOrder,
    product: product
      ? {
          price: product.price,
          compare_at_price: product.compare_at_price,
          status: product.status,
          sort_order: product.sort_order,
        }
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * route
 * ------------------------------------------------------------------ */

export const Route = createFileRoute("/admin/_shell/events/$id")({
  loader: async ({ params }) => {
    const isNew = params.id === NEW_EVENT_ID;
    const { getEventById, listEventProducts, listEvents, listSessionsForEvent } =
      await import("@/lib/admin/fns/events");
    const { listEventCategories } = await import("@/lib/admin/fns/event-categories");
    const { listArtistOptions } = await import("@/lib/admin/fns/artists");
    const { listEventBlocks } = await import("@/lib/admin/fns/event-blocks");
    const [event, categories, artists, products, sessions, events, blocks] = await Promise.all([
      isNew ? Promise.resolve(null) : getEventById({ data: { id: params.id } }),
      listEventCategories(),
      listArtistOptions(),
      listEventProducts(),
      // §3 那一段的資料來源。時間、地點、名額都是場次的屬性，不是活動的 ——
      // 所以那一段在這一頁上是**唯讀的鏡子**，不是輸入框。
      isNew
        ? Promise.resolve([] as SessionBrief[])
        : listSessionsForEvent({ data: { id: params.id } }),
      // 新增時才要知道「下一個排序號」。編輯既有活動時它自己就有 sort_order。
      isNew ? listEvents() : Promise.resolve([]),
      // §5／§8／§9 的三種區塊，一次撈完（三種一起回，由畫面自己分組）。
      // 活動還沒建立時沒有 events.id 可以掛，所以是空的。
      isNew
        ? Promise.resolve([] as BlockRow[])
        : listEventBlocks({ data: { event_id: params.id } }),
    ]);
    if (!isNew && !event) throw notFound();
    return { event, categories, artists, products, sessions, events, blocks, isNew };
  },
  head: ({ params }) => ({
    meta: [
      {
        title: params.id === NEW_EVENT_ID ? "新增活動｜小時光書店後台" : "編輯活動｜小時光書店後台",
      },
    ],
  }),
  component: AdminEventAssemblerPage,
});

/* ------------------------------------------------------------------ *
 * 段落外框
 * ------------------------------------------------------------------ */

/**
 * 一段。
 *
 * 🔴 呼叫端一律寫 `<Section step={nextStep()} …>` **在它該出現的那個位置**，
 *    不可以先算好放進一個 const（見檔頭第 4 點）。
 */
function Section({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-md border border-border p-4" data-step={step}>
      <div className="flex items-start gap-3">
        <Badge variant="outline" className="mt-0.5 shrink-0 font-mono">
          §{step}
        </Badge>
        <div className="min-w-0">
          <h2 className="text-lg font-medium">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * 🔴 雷 6 的第三層：離開頁面的守衛。
 *
 * 兩種「離開」要分開處理，因為瀏覽器只讓其中一種可以自訂畫面：
 *   · **站內換頁**（按側欄、按返回列表）→ useBlocker 攔下來，我們自己畫一個
 *     AlertDialog（withResolver: true 才拿得到 proceed / reset）。
 *   · **關分頁／重新整理／打別的網址** → 只能用瀏覽器自己那個制式對話框。
 *     `enableBeforeUnload` 就是它 —— @tanstack/history 會在 dirty 的時候掛上
 *     beforeunload 監聽器。這裡**不自己再 addEventListener("beforeunload")**：
 *     兩個監聽器的下場是同一次關閉跳兩次確認。
 *
 * ⚠️ 兩個都吃同一個 dirty 旗標。只做前者的話，關分頁會安靜地丟掉所有東西；
 *    只做後者的話，按側欄換頁會安靜地丟掉所有東西。兩個都要。
 */
function useBlockerWithPrompt(shouldBlock: () => boolean) {
  return useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBlock,
    withResolver: true,
  });
}

/* ------------------------------------------------------------------ *
 * 組裝器本體
 * ------------------------------------------------------------------ */

function AdminEventAssemblerPage() {
  const assemblerFormSchema = useMemo(buildAssemblerFormSchema, []);
  const {
    event,
    categories,
    artists: allArtists,
    products,
    sessions,
    events,
    blocks,
    isNew,
  } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();

  const product = event ? products[event.id] : undefined;
  const nextSortOrder = events.reduce((max, e) => Math.max(max, e.sort_order), 0) + 1;

  const form = useForm<AssemblerFormShape>({
    resolver: zodResolver(assemblerFormSchema),
    defaultValues: toFormValues(event, product, nextSortOrder),
  });

  const [submitting, setSubmitting] = useState(false);
  const [sellEnabled, setSellEnabled] = useState(Boolean(product));

  /* ── 雷 6：髒狀態防護，三層 ───────────────────────────────────────────────
     第一層：每一個編輯器把自己的 isDirty 往上報，合成一份「哪幾段還沒存」。
     第二層：sticky bar 上**條件式**的提示（沒有髒東西就一個字都不出現）。
     第三層：useBlocker（站內換頁）＋ enableBeforeUnload（關分頁／重新整理）。 */
  const [dirty, setDirty] = useState<DirtyState>({});
  const isMainDirty = form.formState.isDirty;
  useEffect(() => {
    setDirty((prev) => markDirty(prev, MAIN_SECTION_KEY, isMainDirty));
  }, [isMainDirty]);

  const pageDirty = hasDirty(dirty);
  const bannerText = dirtyBannerText(dirtyKeys(dirty).map((k) => SECTION_LABELS[k] ?? k));

  /* ── §5／§8／§9：三種區塊 ───────────────────────────────────────────────
     一次撈回來的 blocks 依 kind 分組。loader 已經照 (kind, sort_order) 排好，
     所以這裡只要分組，不重排。 */
  const blocksByKind = useMemo(() => {
    const out = Object.fromEntries(
      EVENT_BLOCK_KINDS.map((k) => [k, [] as EventBlockItem[]]),
    ) as Record<EventBlockKind, EventBlockItem[]>;
    for (const b of blocks) out[b.kind]?.push(b);
    return out;
  }, [blocks]);

  /**
   * 區塊編輯器把自己的髒狀態往上報。
   *
   * ⚠️ 一種 kind 一個**穩定**的 callback（useCallback + 空依賴，setState 用 updater
   *    形式所以不需要抓 dirty）。每次 render 都給一個新函式的話，編輯器裡那個
   *    `useEffect(…, [onDirtyChange])` 會每次 render 都重跑。
   */
  const handleBlockDirty = useMemo(
    () =>
      Object.fromEntries(
        EVENT_BLOCK_KINDS.map((kind) => [
          kind,
          (isDirty: boolean) => setDirty((prev) => markDirty(prev, blockSectionKey(kind), isDirty)),
        ]),
      ) as Record<EventBlockKind, (dirty: boolean) => void>,
    [],
  );

  /**
   * 區塊存／刪／排序之後重新載入 loader 的資料。
   *
   * 🔴 只有 router.invalidate()，**沒有 setFormKey**（檔頭雷 1）。主表單與三個區塊
   *    表單都必須活過這一次 —— 使用者可能在 §9 打到一半，而他按的是 §5 的新增。
   */
  const refreshBlocks = useCallback(async () => {
    await router.invalidate();
  }, [router]);

  /**
   * ⚠️ 「新增」存完之後**我們自己要換網址**（/admin/events/new → /admin/events/<id>），
   *    而那一次導頁會撞上自己的離開守衛：form.reset() 讓 isDirty 變成 false，但那要
   *    等到下一次 render 才會反映到 pageDirty 上，而 navigate() 就發生在這一次
   *    render 裡 —— 守衛看到的還是「髒的」，於是店家剛存完就被自己的系統攔下來問
   *    「要離開嗎」。
   *
   *    所以放行用一個 **ref**（讀的是當下的值，不是這一次 render 凍住的值）。
   */
  const bypassLeaveGuard = useRef(false);
  const shouldBlockLeaving = () => pageDirty && !bypassLeaveGuard.current;
  const blocker = useBlockerWithPrompt(shouldBlockLeaving);

  /**
   * 🔴 雷 1：**存完之後不可以 bump formKey。**
   *
   * 這個 repo 的慣例是 `key={formKey}` 強制 remount 取代 reset()。那個慣例對 Dialog
   * 是對的（換一筆資料就整個重來，而 Dialog 本來就會關掉重開）。但這一頁是一張長表單，
   * remount 會把每一個區塊編輯器的**非受控輸入**清空 —— 使用者存了第 2 段，第 9 段
   * 正在打的東西就不見了，而且沒有任何提示。
   *
   * 正確做法：`router.invalidate()` 讓 loader 重跑（列表與鏡子那幾塊要拿到新資料），
   * 然後 `form.reset(nextValues)` 把表單重新對準剛存回來的那一份（順便把 isDirty
   * 歸零）。**沒有 setFormKey。**
   */
  async function handleValid(values: AssemblerFormShape) {
    // 七個清單欄位：三個 textarea 的字串 → 三個陣列。linesToList() 超過上限會丟錯，
    // 而且刻意不 slice —— 靜默截斷等於替店家做一個他不知道的決定。
    let lists: EventListPayload;
    try {
      lists = Object.fromEntries(
        EVENT_LIST_FIELDS.map((f) => [
          f,
          {
            zh: linesToList(values[f].zh),
            en: linesToList(values[f].en),
            ja: linesToList(values[f].ja),
          },
        ]),
      ) as EventListPayload;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "清單欄位超過上限");
      return;
    }

    setSubmitting(true);
    try {
      const { product: productValues, ...fixed } = values;
      /* 🔴 一顆儲存鈕 = 一支 server fn = 一次 RPC = 一個交易。
         固定欄位與七個清單一起進 admin_upsert_event_with_session()，所以不會出現
         「前半段寫進去了、後半段沒有」。也不會在這裡自己組 products 的 payload ——
         那五個投影欄位（標題／摘要／說明／代稱／圖片）的規則只住在那支 SQL 裡。 */
      const { upsertEventWithProduct } = await import("@/lib/admin/fns/events");
      const result = await upsertEventWithProduct({
        data: { ...fixed, ...lists, product: sellEnabled ? (productValues ?? null) : null },
      });

      toast.success(isNew ? "已新增活動" : "已儲存活動");

      const nextValues = toFormValues(
        result.event,
        result.product ?? undefined,
        result.event.sort_order,
      );
      // 先 reset（isDirty 歸零，離開守衛才不會攔住我們自己的導頁），再換網址。
      form.reset(nextValues);
      setSellEnabled(Boolean(result.product));

      if (isNew) {
        bypassLeaveGuard.current = true;
        try {
          await navigate({
            to: "/admin/events/$id",
            params: { id: result.event.id },
            replace: true,
          });
        } finally {
          bypassLeaveGuard.current = false;
        }
        return;
      }
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 🔴 雷 3：handleSubmit 的**第二個參數**。
   *
   * 少了它，驗證失敗時這一頁會什麼都不做 —— 沒有 toast、沒有請求，而唯一的線索（紅字）
   * 很可能在畫面外的第 7 段。使用者看到的是「我按了儲存，然後什麼都沒發生」。
   */
  function handleInvalid(errors: FieldErrors<AssemblerFormShape>) {
    toast.error(invalidToastMessage(collectErrorPaths(errors), FIELD_LABELS));
  }

  function toggleSell(on: boolean) {
    setSellEnabled(on);
    form.setValue(
      "product",
      on
        ? (form.getValues("product") ?? { price: 0, compare_at_price: null, status: "active" })
        : null,
      { shouldDirty: true },
    );
  }

  /**
   * 下拉要列出來的講者：啟用中的，**加上**這一場目前掛著的那一位（就算他已經停用）。
   * 少了後面那半句就是一個無聲的資料流失 —— 隨手按個儲存就把講者洗成空的。
   */
  /**
   * 下拉要列出來的講者：啟用中的，**加上**這一場目前掛著的那一位（就算他已經停用）。
   *
   * 少了後面那半句就是一個無聲的資料流失：講者停用之後，去編輯任何一場已經掛著他的
   * 舊活動，下拉裡選不到目前這個值，隨手按個儲存就把講者洗成空的。
   * （scripts/artists-selftest.mjs 守著這一行。）
   */
  const current = (form.watch("speaker_id") ?? event?.speaker_id) || null;
  const artists: ArtistOption[] = allArtists.filter((a) => a.is_active || a.id === current);

  const latestSession = sessions[0];
  const seatsTaken = sessions.reduce((sum, s) => sum + s.seats_taken, 0);
  const capacity = sessions.reduce((sum, s) => sum + s.capacity, 0);

  /* 🔴 雷 4：段號在畫面上那個位置求值。
     `step` 是一個會被 nextStep() 往前推的計數器，每一次 render 從 0 重新開始。
     **下面每一個 <Section step={nextStep()}> 都必須直接寫在它該出現的位置**；
     把任何一段先算進一個 const，它就會提前領號，整頁從那裡開始全錯。 */
  let step = 0;
  const nextStep = () => (step += 1);

  const displayName = event ? event.title.zh : "新增活動";

  return (
    <Form {...form}>
      <div className="space-y-6 pb-24">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 gap-1.5" asChild>
            <Link to="/admin/events">
              <ArrowLeft className="h-4 w-4" />
              返回活動列表
            </Link>
          </Button>
          <h1 className="mt-2 text-2xl font-medium">{displayName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            由上到下就是前台的順序。<strong>某一段留空，前台那一整塊就不會出現</strong>
            ——留空是「關掉」，不是「還沒填」。
          </p>
        </div>

        {/* 🔴 雷 2：主表單是一個**空的隱藏 <form>**。理由見 CONTENT_FORM_ID 的註解：
            HTML 的 form 不能巢狀，而這一頁未來每一段區塊編輯器都要有自己的 form。 */}
        <form
          id={CONTENT_FORM_ID}
          className="hidden"
          onSubmit={form.handleSubmit(handleValid, handleInvalid)}
        />

        <Section
          step={nextStep()}
          title="基本資料"
          description="這一段決定這場活動的身分：網址、分類、主講人、封面與發布狀態。"
        >
          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>網址代稱</FormLabel>
                <FormControl>
                  <Input
                    placeholder="留空＝沿用系統代號"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value)}
                  />
                </FormControl>
                {/* 🔴 這一段是這一整頁最重要的一句警告。0026 把 slug 回填成系統代號，
                    所以在那之前發出去的網址現在都還有效；**改掉它的那一刻，那些網址
                    就 404 了**（活動頁對查無此活動是真的回 404，不是導回列表）。 */}
                <FormDescription>
                  網址是 /events/<span className="font-mono">{field.value || "（系統代號）"}</span>
                  。⚠️ 改代稱會讓**已經發出去的舊網址 404** —— 社群貼文、電子報、名片上的 QR code
                  都算。要改就要有人把那些地方一起改掉。 改了之後商品網址也會跟著變成 /shop/event-
                  <span className="font-mono">代稱</span>。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="display_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>顯示用日期文字</FormLabel>
                <FormControl>
                  <Input placeholder="例如 2026.05.24  Sat  19:30，或「即將公告」" {...field} />
                </FormControl>
                <FormDescription>自由文字，不會被當成日期解析，直接顯示在網站上。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="iso_date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>標準日期（選填）</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value === "" ? null : e.target.value)}
                  />
                </FormControl>
                <FormDescription>
                  目前沒有任何頁面讀取這個欄位，保留給未來依日期排序、篩選使用。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>分類</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="請選擇分類" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {categories.map((c: EventCategoryRow) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.label.zh}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <MirrorNote
            label="活動分類"
            source="活動分類"
            to="/admin/categories"
            hint={
              categories.length === 0
                ? "目前一個分類都沒有 —— 要先去新增至少一個，這場活動才存得起來。"
                : undefined
            }
          >
            共 {categories.length} 個分類可選。分類與活動之間有資料庫關聯，不能自由輸入。
          </MirrorNote>

          <FormField
            control={form.control}
            name="speaker_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>主講人（選填）</FormLabel>
                <Select
                  value={field.value ?? NO_SPEAKER}
                  onValueChange={(v) => field.onChange(v === NO_SPEAKER ? null : v)}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="不指定" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NO_SPEAKER}>不指定</SelectItem>
                    {artists.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        {a.discipline ? `（${a.discipline}）` : ""}
                        {a.is_active ? "" : "・已停用"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <MirrorNote label="講者" source="講者" to="/admin/artists">
            {current
              ? `目前指定：${allArtists.find((a) => a.id === current)?.name ?? current}`
              : "這場不顯示講者介紹。"}
          </MirrorNote>

          <FormField
            control={form.control}
            name="image_key"
            render={({ field }) => (
              <FormItem>
                <FormLabel>活動圖片（選填）</FormLabel>
                {/* 🔴 雷 5：ImageField **不可以**包在 <FormControl>（Radix Slot）裡。
                    它是複合元件，不是 forwardRef 的原生元件，Slot 的 ref cloning 只會
                    噴 warning。與 _shell.pages.$slug.tsx、_shell.exhibitions.tsx 同一個寫法。 */}
                <ImageField
                  value={field.value ?? null}
                  onChange={field.onChange}
                  fallback={eventReading}
                />
                <FormDescription>
                  上架之後它也會出現在 /shop 的商品卡與商品頁上；活動頁本身則是這張圖
                  以通欄大圖的方式出現在標題下方。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="gallery_keys"
            render={({ field }) => (
              <FormItem>
                <FormLabel>活動相簿（選填）</FormLabel>
                {/* GalleryField 跟 ImageField 一樣是複合元件，不可以包在
                    <FormControl>（Radix Slot）裡——同一個雷 5。 */}
                <GalleryField value={field.value ?? []} onChange={field.onChange} />
                <FormDescription>
                  上傳的照片會依序出現在活動頁的「更多照片」區；沒有照片就不會畫出這一區。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="sort_order"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>排序（數字越小越前面）</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value}
                      onChange={(e) =>
                        field.onChange(e.target.value === "" ? 0 : Number(e.target.value))
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="is_published"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>發布狀態</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "已發布" : "草稿"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </Section>

        <Section
          step={nextStep()}
          title="標題與說明"
          description="前台最上面那一塊。中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。"
        >
          <LocalizedField name="title" label="標題" />
          <LocalizedField name="summary" label="摘要" multiline />
          <LocalizedField name="description" label="說明" multiline />
        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            🔴 §3 是**唯讀的鏡子**，而且必須一直是。

            場次的新增／修改在 /admin/registrations。這一段一個輸入框都沒有，理由不是
            「還沒做」，是 **seats_taken 只能由持有列鎖的那三支 RPC 維護**（0020 §7）：
            從別的地方寫回一個幾分鐘前讀到的計數器，就是超賣 —— 兩個後台分頁同時開著、
            兩個人各按一次儲存，最後一個人寫回去的數字會把中間所有報名吃掉。

            所以這裡只 render，不 useForm、不 FormField、不打任何寫入的 server fn。
            ══════════════════════════════════════════════════════════════════ */}
        <Section
          step={nextStep()}
          title="場次（時間與名額）"
          description="一場活動可以有好幾梯。時間、地點、名額都是場次的屬性，不是活動的——所以這一段在這裡只看得到，改要去「活動報名」頁。"
        >
          {sessions.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              尚無場次。沒有場次的活動商品，客人點進去一場都選不到。
            </p>
          ) : (
            <ol className="space-y-2">
              {sessions.map((s) => (
                <li key={s.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{s.title.zh || "（未填場次名稱）"}</p>
                    <Badge variant="outline">{SESSION_STATUS_LABEL[s.status] ?? s.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {/* 不可以 toLocaleString：伺服器（UTC、Node 的 ICU）與瀏覽器印出來的字
                        不一樣 → React #418。見 src/lib/taipei-time.ts。 */}
                    {formatTaipeiDateTime(s.starts_at)}・{s.location.zh || "（未填地點）"}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    名額 {s.seats_taken} / {s.capacity}
                  </p>
                </li>
              ))}
            </ol>
          )}

          {sessions.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              共 {sessions.length} 場場次，合計 {seatsTaken} / {capacity} 個名額。
            </p>
          ) : null}

          <MirrorNote
            label="活動地點"
            source="活動報名（場次）"
            to="/admin/registrations"
            hint="一場活動的兩個梯次可以辦在兩個地方，所以地點沒有「活動層級」的答案——上面列的是每一場各自的地點。名額（seats_taken）由報名流程在資料庫裡維護，這一頁**改不動**，那是為了不讓兩個分頁互相覆蓋成超賣。"
          >
            {latestSession ? (
              <span>
                {latestSession.location.zh || "（未填地點）"}
                <span className="text-xs">（最近一場，共 {sessions.length} 場場次）</span>
              </span>
            ) : (
              <span>尚無場次。</span>
            )}
          </MirrorNote>
        </Section>

        <Section
          step={nextStep()}
          title="報名與售票"
          description="這場怎麼收報名、要不要收錢、上不上架成商品。"
        >
          <FormField
            control={form.control}
            name="external_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>報名／活動網址</FormLabel>
                <FormControl>
                  <Input type="url" placeholder="https://example.com/event" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="registration_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>報名方式</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(Object.keys(REGISTRATION_TYPE_LABEL) as ("external" | "internal")[]).map(
                        (v) => (
                          <SelectItem key={v} value={v}>
                            {REGISTRATION_TYPE_LABEL[v]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="payment_enabled"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>需付款</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "是" : "否"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* 名額顯示。放在這一段是因為它跟上面的名額、下面的售票是同一類設定 ——
              「這場怎麼收報名」的一部分，不是活動內容。

              🔴 它**只關掉「尚餘名額 N」那一句**。「已額滿」不受影響，永遠會顯示：
                 那是「你報不了名」，跟「還剩幾位」不是同一件事，而客人必須看得出
                 前者。下面那句說明文字就是講給店家聽的同一件事，不要拿掉。 */}
          <FormField
            control={form.control}
            name="show_seats_remaining"
            render={({ field }) => (
              <FormItem>
                <FormLabel>在前台顯示剩餘名額</FormLabel>
                <div className="flex h-9 items-center gap-2">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <span className="text-sm text-muted-foreground">
                    {field.value ? "顯示「尚餘名額 N」" : "不顯示剩餘名額"}
                  </span>
                </div>
                <FormDescription>
                  {SEATS_VISIBILITY_HINT}
                  <strong className="font-medium text-foreground">
                    　關掉之後「已額滿」還是會顯示。
                  </strong>
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <MirrorNote
            label="報名名單"
            source="活動報名"
            to="/admin/registrations"
            hint="名單是第三人的個資，要「查看活動報名名單」權限才看得到，所以它不在這一頁。"
          >
            {sessions.length > 0
              ? `目前 ${sessions.length} 場場次，共 ${seatsTaken} / ${capacity} 個名額已被報走。`
              : "還沒有場次，所以還沒有人報得了名。"}
          </MirrorNote>

          {/* ── 上架成商品 ──────────────────────────────────────────────────
              這一塊送出去就是 0027 的 admin_upsert_event_with_session()：活動與商品
              在一個交易裡寫完。刻意**沒有**標題／摘要／說明／圖片欄位 —— 那五樣是從
              上面的活動欄位投影過去的（其中商品說明取的是活動的**摘要**，不是說明），
              規則住在那支 SQL 函式裡。在這裡多開一個欄位，就是替那條規則開第二個家。 */}
          <div className="space-y-4 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">上架成可報名商品</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {product
                    ? "這場活動已經有商品了。關掉這個開關不會刪掉它，只是這一次儲存不動它。"
                    : "打開之後，儲存時會同時建立這場活動的商品（/shop/event-代稱）。"}
                </p>
              </div>
              <Switch checked={sellEnabled} onCheckedChange={toggleSell} />
            </div>

            {sellEnabled ? (
              <div className="grid grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="product.price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>售價（NT$）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={field.value ?? 0}
                          onChange={(e) =>
                            field.onChange(e.target.value === "" ? 0 : Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="product.compare_at_price"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>原價（選填）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(e.target.value === "" ? null : Number(e.target.value))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="product.status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>商品狀態</FormLabel>
                      <Select value={field.value ?? "active"} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(
                            Object.keys(
                              PRODUCT_STATUS_LABEL,
                            ) as (keyof typeof PRODUCT_STATUS_LABEL)[]
                          ).map((v) => (
                            <SelectItem key={v} value={v}>
                              {PRODUCT_STATUS_LABEL[v]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : null}

            {/* 五塊鏡子裡唯一**方向相反**的一塊：這一頁會產生那邊的資料。 */}
            <MirrorNote
              label="這場活動的商品"
              source="商品"
              to="/admin/products"
              direction="source"
              hint="名額不在商品上，也不在這一頁——名額是場次的屬性。"
            >
              {product
                ? `/shop/event-${event?.slug} ・ ${PRODUCT_STATUS_LABEL[product.status]} ・ NT$${product.price.toLocaleString("en-US")} ・ ${product.session_count} 個場次`
                : "尚未上架。"}
            </MirrorNote>
          </div>
        </Section>

        {/* ══════════════════════════════════════════════════════════════════
            🔴 §5／§8／§9 三段區塊，共用 <EventBlockEditor />（三種 kind 的資料形狀
               完全相同，理由見 src/lib/admin/event-block-copy.ts 的檔頭）。

            每一個編輯器**內部再開一層 <Form {...blockForm}>**。LocalizedField 是從
            useFormContext() 拿 control 的，少了那一層它會綁到**主表單**的 control 上
            —— 打在區塊裡的字會寫進活動的欄位（而且兩邊剛好都有 title/body，所以連型別
            錯誤都不會有）。做在 EventBlockEditor.tsx，理由與證明寫在那個檔案的檔頭。

            ⚠️ 這裡**不可以**給編輯器一個會隨資料變動的 key（例如 blocks.length 或
               updated_at）。那等於每次主儲存都把三個區塊表單 remount 一次，使用者
               正在打的字會安靜地消失 —— 檔頭雷 1 的同一件事。
            ══════════════════════════════════════════════════════════════════ */}
        <Section
          step={nextStep()}
          title={EVENT_BLOCK_COPY.agenda.sectionTitle}
          description={EVENT_BLOCK_COPY.agenda.sectionDescription}
        >
          <EventBlockEditor
            eventId={event?.id ?? ""}
            kind="agenda"
            rows={blocksByKind.agenda}
            onDirtyChange={handleBlockDirty.agenda}
            onChanged={refreshBlocks}
            disabledReason={isNew ? NEW_EVENT_BLOCK_NOTE : null}
          />
        </Section>

        <Section
          step={nextStep()}
          title="活動亮點與收穫"
          description="一行一項。整段留空，前台就不會出現這一塊。"
        >
          <LocalizedListField name="highlights" label="活動亮點" optional />
          <LocalizedListField name="takeaways" label="帶得走什麼" optional />
        </Section>

        <Section
          step={nextStep()}
          title="適合與不適合對象"
          description="一行一項。「這場不適合誰」講清楚會減少現場的失望，所以它與「適合對象」刻意分成兩欄，而不是用否定句寫在同一欄。"
        >
          <LocalizedListField name="suitable_for" label="適合對象" optional />
          <LocalizedListField name="not_suitable_for" label="不適合對象" optional />
        </Section>

        <Section
          step={nextStep()}
          title={EVENT_BLOCK_COPY.info_row.sectionTitle}
          description={EVENT_BLOCK_COPY.info_row.sectionDescription}
        >
          <EventBlockEditor
            eventId={event?.id ?? ""}
            kind="info_row"
            rows={blocksByKind.info_row}
            onDirtyChange={handleBlockDirty.info_row}
            onChanged={refreshBlocks}
            disabledReason={isNew ? NEW_EVENT_BLOCK_NOTE : null}
          />
        </Section>

        <Section
          step={nextStep()}
          title={EVENT_BLOCK_COPY.faq.sectionTitle}
          description={EVENT_BLOCK_COPY.faq.sectionDescription}
        >
          <EventBlockEditor
            eventId={event?.id ?? ""}
            kind="faq"
            rows={blocksByKind.faq}
            onDirtyChange={handleBlockDirty.faq}
            onChanged={refreshBlocks}
            disabledReason={isNew ? NEW_EVENT_BLOCK_NOTE : null}
          />
        </Section>

        <Section
          step={nextStep()}
          title="流程大綱與費用包含"
          description="一行一項。⚠️「費用包含」只寫「含一杯飲料」這種內容——金額的唯一真相在商品的售價，不要在這裡寫數字。"
        >
          <LocalizedListField name="outline" label="流程大綱" optional />
          <LocalizedListField name="includes" label="費用包含" optional />
        </Section>

        <Section
          step={nextStep()}
          title="注意事項"
          description="一行一項。整段留空，前台就不會出現這一塊。"
        >
          <LocalizedListField name="notes" label="注意事項" optional />
        </Section>

        {/* ── sticky bar ─────────────────────────────────────────────────────
            🔴 雷 6 的第二層：提示是**條件式**的。沒有髒東西時 bannerText 是 null，
            這一條上一個字都不會出現。常駐一句「記得儲存」的下場是人在第三天就停止
            閱讀它，於是真的有東西沒存的那一次也一起被跳過。 */}
        <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-6 py-3 backdrop-blur">
          <p className="text-sm text-muted-foreground">
            {bannerText ? (
              <span className="font-medium text-destructive">{bannerText}</span>
            ) : (
              <span>共 {step} 段。</span>
            )}
          </p>
          <Button
            type="submit"
            form={CONTENT_FORM_ID}
            disabled={submitting || categories.length === 0}
          >
            {submitting ? "儲存中…" : isNew ? "新增活動" : "儲存活動內容"}
          </Button>
        </div>

        <AlertDialog open={blocker.status === "blocked"}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>要離開這一頁嗎？</AlertDialogTitle>
              <AlertDialogDescription>
                {bannerText ?? "這一頁還有沒儲存的變更"}。離開就會失去這些變更。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => blocker.reset?.()}>留在這一頁</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => blocker.proceed?.()}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                離開，不儲存
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Form>
  );
}
