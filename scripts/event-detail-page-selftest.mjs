#!/usr/bin/env node
/**
 * event-detail-page-selftest.mjs —— /events/$slug（活動詳情頁）的自檢
 *
 * ── 為什麼是新開一支，不是加進 event-registration-selftest ──────────────────
 * 那一支守的是 0020 的**報名管線**不變量（reserve_session_seat 的七步、名額的
 * 單一真相、event_registrations 的零 grant），而且它有一整段要連本機 PostgreSQL
 * 才跑得到。這一支守的是**一個公開路由的形狀**：檔名、三種讀取結果各自走到哪裡、
 * 有沒有讀到不存在的欄位。兩者失敗時要叫回來的人不同、要看的檔案不同，混在同一
 * 支 1400 行的檔案裡，往後只會讓「哪一條紅了代表什麼」愈來愈難回答。
 *
 * 這一支**完全靜態**：只讀原始碼，不連任何資料庫，所以在任何機器上都會跑。
 *
 * ── 🔴 這個 repo 出過三次假陽性，所以每一條斷言都先 stripTs() ───────────────
 * 斷言被**註解內容**餵飽是這裡最常見的失敗模式，而這個 repo 的檔頭特別長。具體
 * 例子就在這一期：src/routes/events.$slug.tsx 的檔頭寫著「imageFor(key, fallback)
 * 永遠會回一張圖」——「這一頁沒有呼叫 imageFor」這條斷言如果直接對整個檔案跑，
 * 會因為那句註解而**假性變紅**；反過來，「有渲染 <SessionList」如果對整個檔案跑，
 * 也可能被某句提到它的註解**假性變綠**。所以下面每一條都對 stripTs() 之後的
 * 程式碼跑，而且範圍能縮小就縮小（例如只對 fetchEventBySlug 的函式本體）。
 *
 * 執行：node scripts/event-detail-page-selftest.mjs（或 npm test）
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/event-detail-page-selftest.mjs";

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  if (Object.is(actual, expected)) {
    pass += 1;
    console.log(green(`  ✓ ${label}`));
  } else {
    fail += 1;
    console.log(red(`  ✗ ${label}`));
    console.log(red(`      期望 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`));
  }
}

const checkTrue = (label, value) => check(label, Boolean(value), true);
const checkFalse = (label, value) => check(label, Boolean(value), false);

/**
 * 讀原始碼。**檔案不存在 = 丟例外**，不是回空字串。
 *
 * 這裡曾經是 `existsSync(p) ? readFileSync(p, "utf8") : ""`。問題在於這一支底下大量
 * 的斷言長成 `check("…沒有 X", src.includes("X"), false)` —— 路徑一打錯（或檔案被改名、
 * 搬走），`"".includes("X")` 就是 `false`，那條斷言**靜默通過**，從此永遠是綠的，而且
 * 再也沒有在檢查任何東西。正面斷言會轉紅所以是安全的；只有否定斷言會這樣壞掉。
 * 見 run-selftests.mjs 的「守門 4」。
 */
const readFile = (p) => {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) {
    throw new Error(
      `selftest 讀不到檔案：${abs}` +
        "（路徑打錯，或檔案被改名／搬走了。這裡刻意不回空字串 —— 回空字串會讓所有" +
        "「確認原始碼裡沒有 X」的否定斷言靜默通過。）",
    );
  }
  return readFileSync(abs, "utf8");
};

// 守著 readFile() 自己：路徑打錯時它必須炸掉，而不是回空字串讓否定斷言靜默通過。
{
  const ghost = "__selftest-missing-file-probe__";
  let thrown = null;
  try {
    readFile(ghost);
  } catch (e) {
    thrown = e;
  }
  checkTrue(
    "🔴 readFile() 讀不到檔案時丟例外，訊息指出是哪個路徑（不是靜默回空字串）",
    thrown !== null && String(thrown.message).includes(join(ROOT, ghost)),
  );
}

/** 拿掉 TypeScript 的註解（`//` 整行與 `/* … *\/` 區塊）—— 見檔頭的假陽性說明。 */
function stripTs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** 切出一支 `export async function name(` 到下一個頂層 export 之間的本體。 */
function fnBody(code, name) {
  const start = code.indexOf(`export async function ${name}(`);
  if (start === -1) return "";
  const rest = code.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return rest.slice(0, end === -1 ? rest.length : end);
}

const ROUTE_DETAIL = "src/routes/events.$slug.tsx";
const ROUTE_INDEX = "src/routes/events.index.tsx";
const ROUTE_OLD = "src/routes/events.tsx";

const detailCode = stripTs(readFile(ROUTE_DETAIL));
const indexCode = stripTs(readFile(ROUTE_INDEX));
const cmsCode = stripTs(readFile("src/lib/cms.ts"));
const shopCode = stripTs(readFile("src/lib/shop.ts"));
const pickerCode = stripTs(readFile("src/components/shop/SessionPicker.tsx"));
const routeTree = readFile("src/routeTree.gen.ts");

// =============================================================================
// [1] 路由改名：不可以兩份並存
// =============================================================================
console.log("\n[1] 路由改名");
// flat routing 下留著 events.tsx 會讓它變成 /events 底下的 parent layout，
// 需要 <Outlet /> 才畫得出子路由 —— 沒有的話 /events/$slug 就是一片空白。
// repo 自己的慣例已經給了答案：沒有 shop.tsx，只有 shop.index.tsx + shop.$slug.tsx。
check(`${ROUTE_OLD} 不存在（改名真的完成了）`, existsSync(join(ROOT, ROUTE_OLD)), false);
checkTrue(`${ROUTE_INDEX} 存在`, existsSync(join(ROOT, ROUTE_INDEX)));
checkTrue(`${ROUTE_DETAIL} 存在`, existsSync(join(ROOT, ROUTE_DETAIL)));
// 對照組：同一組形狀的先例必須還在，否則上面兩條的「慣例」就沒有依據。
checkTrue("先例 shop.index.tsx 還在", existsSync(join(ROOT, "src/routes/shop.index.tsx")));
checkTrue("先例 shop.$slug.tsx 還在", existsSync(join(ROOT, "src/routes/shop.$slug.tsx")));
check("先例裡也沒有 shop.tsx", existsSync(join(ROOT, "src/routes/shop.tsx")), false);

// 反空殼：先證明兩個檔案真的有內容，否則底下每一條 test() 都是假性結果。
checkTrue("反空殼：events.$slug.tsx 讀得到程式碼", detailCode.length > 2500);
checkTrue("反空殼：events.index.tsx 讀得到程式碼", indexCode.length > 2500);

checkTrue('events.index.tsx 宣告成 "/events/"', /createFileRoute\("\/events\/"\)/.test(indexCode));
checkTrue(
  'events.$slug.tsx 宣告成 "/events/$slug"',
  /createFileRoute\("\/events\/\$slug"\)/.test(detailCode),
);
// 參數叫 $slug 不叫 $id 是刻意的：之後補 events.slug 時用 slug = id 回填，
// 今天發出去的網址仍然有效。
checkFalse("路由參數沒有寫成 $id", /createFileRoute\("\/events\/\$id"\)/.test(detailCode));

// =============================================================================
// [2] routeTree.gen.ts 跟著改名走，而且進了版控
// =============================================================================
console.log("\n[2] routeTree.gen.ts");
checkTrue("routeTree 是 tracked 檔案", existsSync(join(ROOT, "src/routeTree.gen.ts")));
checkTrue("反空殼：routeTree 讀得到", routeTree.length > 10000);
checkTrue("routeTree import 了 events.index", /from '\.\/routes\/events\.index'/.test(routeTree));
checkTrue("routeTree import 了 events.$slug", /from '\.\/routes\/events\.\$slug'/.test(routeTree));
// 舊的那一行必須消失 —— 留著就代表 routeTree 沒重新產生，部署上去會找不到檔案。
checkFalse(
  "routeTree 不再 import 舊的 ./routes/events",
  /from '\.\/routes\/events'/.test(routeTree),
);
checkTrue("routeTree 有 /events/$slug 這條路由", routeTree.includes("'/events/$slug'"));

// =============================================================================
// [3] 三種讀取結果各自走到哪裡 —— 這一頁最容易做錯的一條
// =============================================================================
console.log("\n[3] 查無 / 讀取失敗 / 沒有場次，是三件事");
const bySlugBody = stripTs(fnBody(readFile("src/lib/cms.ts"), "fetchEventBySlug"));
checkTrue("切得出 fetchEventBySlug 的本體", bySlugBody.length > 400);

// (a) 查無此活動（或未發布）→ 真的 404。
checkTrue(
  "loader 只有在「查不到而且不是讀取失敗」時才 notFound()",
  /if \(!event && !unavailable\) throw notFound\(\);/.test(detailCode),
);
// 🔴 讀取失敗絕對不能 404。下面兩條把「唯一一次 notFound()」釘死：整個檔案只有
//    一處呼叫它，而且就是上面那一行帶著 !unavailable 的守衛。少了守衛，資料庫
//    眨一下眼就等於告訴搜尋引擎這場活動不存在。
check("整個路由只呼叫一次 notFound()", (detailCode.match(/notFound\(\)/g) ?? []).length, 1);
checkFalse(
  "沒有任何一處無條件 notFound()",
  /(^|[^!&\s])\s*throw notFound\(\);/m.test(
    detailCode.replace("if (!event && !unavailable) throw notFound();", ""),
  ),
);
// (b) 讀取失敗 → 頁殼 + 「暫時無法載入」，不是空白也不是 404。
checkTrue("讀取失敗有自己的分支", /if \(!event\) \{/.test(detailCode));
checkTrue("該分支渲染頁殼", /if \(!event\) \{[\s\S]{0,400}<PageShell>/.test(detailCode));
checkTrue(
  "該分支顯示 unavailable 文案",
  /if \(!event\) \{[\s\S]{0,600}t\(PAGE\.unavailable\)/.test(detailCode),
);
checkFalse("讀取失敗的分支不是 return null", /if \(!event\) \{\s*return null;/.test(detailCode));

// (c) 資料層必須真的分得出這兩種結果，否則路由那條守衛沒有東西可以判斷。
checkTrue("cms.ts 匯出 fetchEventBySlug", /export async function fetchEventBySlug/.test(cmsCode));
checkTrue(
  "回傳型別帶著 unavailable",
  /event: EventDetailEntry \| null;\s*unavailable: boolean;/.test(cmsCode),
);
checkTrue(
  "查無此列時回 unavailable: false",
  /if \(!data\) return \{ event: null, unavailable: false \};/.test(bySlugBody),
);
checkTrue(
  "錯誤時回 unavailable: true",
  /return \{ event: null, unavailable: true \};/.test(bySlugBody),
);
// 這一支不可以退回 bundled 的舊資料 —— 那等於把 0001 的種子當成現況印給客人看。
checkFalse("詳情頁不退回 FALLBACK_EVENTS", /FALLBACK_EVENTS/.test(bySlugBody));
// 也不可以借用本檔那個「把每一種失敗都吞成 null」的 select()。
checkFalse("沒有走會吞掉錯誤的 select() helper", /await select\(/.test(bySlugBody));

// =============================================================================
// [4] 只讀 public.events 真的有的欄位
// =============================================================================
console.log("\n[4] 不 select 不存在的欄位");
// 這個 repo 剛因為 select 了一個還沒套上正式庫的欄位（0025 的 speaker_id）
// 把整個活動後台弄掛 —— PostgREST 對此回 42703，整頁 500。
// ⚠️ 正則要容忍換行與尾逗號：這個 select 字串加上 slug 之後超過 printWidth=100，
// prettier 會把它折成 `.select(\n  "…",\n)`。原本寫死 `.select("…")` 的版本會在那
// 一刻抓不到東西 —— 而抓不到的下場不是紅，是下面整組欄位斷言**一條都不跑**。
const selectMatch = /\.select\(\s*"([^"]*)"\s*,?\s*\)/.exec(bySlugBody);
checkTrue("找得到 fetchEventBySlug 的 select 字串", Boolean(selectMatch));
const selectedCols = (selectMatch?.[1] ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
// 正式庫 public.events 的欄位全集（0001 的 14 欄 + 0025 的 speaker_id
// + 0026 的 slug / image_key + 0027 的七個清單欄位 + 0029 的 show_seats_remaining）。
//
// ⚠️ 這一份是**事實清單**，不是白名單 —— 它的用途是抓「select 了一個 events 根本沒有
//    的欄位」。真的加了欄位就要補進來，補了不會放寬任何東西（下面那三條 ghost 斷言
//    才是「這一頁不准選它」的守衛，show_seats_remaining 同樣列在裡面）。
const EVENT_COLUMNS = new Set([
  "id",
  "title",
  "summary",
  "description",
  "display_date",
  "iso_date",
  "category",
  "external_url",
  "registration_type",
  "payment_enabled",
  "sort_order",
  "is_published",
  "created_at",
  "updated_at",
  "speaker_id",
  "slug",
  "image_key",
  // 0029_event_seats_visibility.sql
  "show_seats_remaining",
  // 0031_event_gallery.sql —— 相簿。
  "gallery_keys",
  // 0027_event_blocks.sql —— 七個「一行一項」清單欄位。
  //
  // ⚠️ 上面的檔頭從當初就寫著「+ 0027 的七個清單欄位」，但這份清單裡一直沒有它們。
  //    沒被抓到是因為 0027 之後**沒有任何路由 select 過它們**（後台能編、前台不讀），
  //    所以這七欄從來沒有走到這組斷言。這一期詳情頁開始把它們印成區塊，補上。
  "highlights",
  "suitable_for",
  "not_suitable_for",
  "takeaways",
  "outline",
  "includes",
  "notes",
]);
checkTrue("select 不是空的", selectedCols.length >= 6);
for (const col of selectedCols) {
  checkTrue(`select 的 "${col}" 是 events 真的有的欄位`, EVENT_COLUMNS.has(col));
}
// slug 從 0026 起是**必須**選出來的：詳情頁要拿它去反查商品
// （products.slug = event-<events.slug>）。少了它，那條反查只能退回 params.slug，
// 而那正是「網址正規化之後安靜查錯東西」的入口。
checkTrue("select 有帶到 slug（0026 之後這一頁靠它反查商品）", selectedCols.includes("slug"));
// 🔴 0031 起 image_key 與 speaker_id 反過來變成**必須**選出來：大圖靠 image_key，
// 講者反查（events -> artists）靠 speaker_id。舊版這裡守的是「這兩欄不該被選」，
// 因為那時候這一頁刻意不畫封面、也沒有講者區——那個決定本身變了，斷言要跟著改
// 守新的事實，不是把它刪掉了事（見 [5] 檔頭的同一個決定）。
for (const required of ["image_key", "speaker_id", "gallery_keys"]) {
  checkTrue(`select 有帶到 ${required}（0031 起這一頁真的要讀）`, selectedCols.includes(required));
}
// 0027 的七個清單欄位：後台從那時候就能編，但前台一直沒有讀過，填了等於沒填。
// 這一期前台開始把它們印成區塊（events.$slug.tsx），所以每一欄都必須在 select 裡。
//
// 🔴 名單是從 src/lib/event-blocks.ts **解析**出來的，不在這裡再抄一份 —— 抄一份
//    的話這條斷言只是對著自己的副本點頭，那份名單日後加一欄，照樣沒有人會發現
//    cms.ts 的 select 漏了它。切不出來一律 throw：回一個空陣列會讓底下整個迴圈
//    一條都不跑，而「一條都不跑」在畫面上跟全部通過長得一模一樣。
const blocksSrc = readFileSync(join(ROOT, "src/lib/event-blocks.ts"), "utf8");
const listFieldsBlock = /export const EVENT_LIST_FIELDS = \[([\s\S]*?)\] as const;/.exec(blocksSrc);
if (!listFieldsBlock) {
  throw new Error(
    "切不出 EVENT_LIST_FIELDS —— event-blocks.ts 換了寫法就要一起改這支自檢，不可以讓它安靜地回空陣列",
  );
}
const listFields = [...listFieldsBlock[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
checkTrue("EVENT_LIST_FIELDS 真的解析出欄位（不是空陣列）", listFields.length > 0);
for (const field of listFields) {
  checkTrue(
    `select 有帶到清單欄位 "${field}"（0027，這一頁要印成區塊）`,
    selectedCols.includes(field),
  );
}
// 光是 select 進來還不夠 —— 0027 那七欄在這一期之前就是「查得到、沒人印」。
// 這一條守的是前台真的把它們畫出來：少了這條，日後有人把區塊刪掉，上面每一條
// select 斷言還是全綠。
checkTrue(
  "詳情頁真的渲染清單區塊（有 import 並走訪 EVENT_LIST_FIELDS）",
  /from "@\/lib\/event-blocks"/.test(detailCode) && /EVENT_LIST_FIELDS\.map\(/.test(detailCode),
);
// payment_enabled 從 0001 就存在而五期以來沒有任何路由讀它，不該被想當然耳選進來。
// show_seats_remaining（0029）也在這一組：這一頁畫的是 SessionList，而那個旗標是
// 從**商品**那一側讀進來的（products.show_seats_remaining → ShopProduct）。從 events
// 再讀一份，就是替同一個事實開第二個來源。
for (const ghost of ["payment_enabled", "show_seats_remaining"]) {
  check(`select 沒有帶到 ${ghost}`, selectedCols.includes(ghost), false);
}
// 網址吃的是 events.slug（0026 回填成 id，所以舊網址仍然有效）。
checkTrue('查詢條件是 .eq("slug", slug)', /\.eq\("slug", slug\)/.test(bySlugBody));
checkFalse('沒有留著舊的 .eq("id", slug)', /\.eq\("id", slug\)/.test(bySlugBody));

// =============================================================================
// [5] 大圖／講者照片／相簿都要「先判斷非空，才呼叫 imageFor()」
// =============================================================================
console.log("\n[5] imageFor() 一定要有守衛才能呼叫");
// 🔴 這一條原本守的是「這一頁完全不呼叫 imageFor()」（0026 剛加 image_key 那時候，
//    這一頁刻意不畫封面）。這一期起真的要畫大圖、講者照片、相簿，所以原本的斷言
//    現在**注定**要轉紅——這裡是有意識地把它改成守新行為，不是刪掉了事：
//    imageFor(key, fallback) 永遠會回一張圖這件事沒有變，變的是「這一頁現在有三處
//    需要畫圖，而且每一處都必須先判斷對應的資料非空，才可以呼叫 imageFor()」。
//    src/lib/cms.ts#EventDetailEntry 的型別註解與這支測試檔頭都寫著同一句話。
checkTrue(
  "路由現在會呼叫 imageFor()（大圖／講者照片／相簿都要用到）",
  /imageFor\(/.test(detailCode),
);
checkTrue("路由 import 了 imageFor", /from "@\/lib\/images"/.test(detailCode));

// 大圖：event.imageKey 非空才畫，而且沒有資料時整塊是 null——不是一張假的
// fallback 圖片，也不是一個空的 <section>。
checkTrue(
  "大圖：先判斷 event.imageKey 非空，中間呼叫 imageFor(event.imageKey, …)，沒有資料就整塊 null",
  /event\.imageKey \? \([\s\S]{0,500}?imageFor\(event\.imageKey,\s*""\)[\s\S]{0,300}?\)\s*:\s*null/.test(
    detailCode,
  ),
);

// 講者：event.speaker 非 null 才畫這一整塊；塊內的照片再另外判斷
// event.speaker.imageKey 非空——**兩層判斷都要在**，因為講者可以只填名字（還沒
// 上傳照片），那時候只印名字，不能因為外層判斷過了就對 imageFor() 少一道防線。
// 視窗上限 2026-09 從 600 調到 800，理由與下面相簿那條一樣：講者照的 <img> 補了
// loading="lazy" + width/height，把這個區塊撐到 662 字元。
checkTrue(
  "講者區：先判斷 event.speaker 非 null，沒有資料就整塊 null",
  /event\.speaker \? \([\s\S]{0,800}?\)\s*:\s*null/.test(detailCode),
);
checkTrue(
  "講者照片：區塊內再判斷 event.speaker.imageKey 非空，才呼叫 imageFor()",
  /event\.speaker\.imageKey \? \([\s\S]{0,200}?imageFor\(event\.speaker\.imageKey,\s*""\)/.test(
    detailCode,
  ),
);

// 相簿：event.galleryKeys.length > 0 才畫，陣列本身空的時候整塊 null；陣列裡
// 每一張圖也是透過 imageFor() 解析，不是自己另外兜一條路徑。
// 視窗上限 2026-09 從 700 調到 900：載入速度優化這一期給相簿的 <img> 加了
// loading="lazy" + width/height（下方單獨斷言），多出來的屬性把這個區塊撐到
// 773 字元，超過舊上限；900 留一點餘裕但仍然是有界視窗，不是「比對到檔尾」。
checkTrue(
  "相簿：先判斷 event.galleryKeys.length > 0，沒有照片就整塊 null",
  /event\.galleryKeys\.length > 0 \? \([\s\S]{0,900}?\)\s*:\s*null/.test(detailCode),
);
checkTrue(
  "相簿：陣列裡每一張圖都呼叫 imageFor()",
  /event\.galleryKeys\.map\([\s\S]{0,200}?imageFor\(/.test(detailCode),
);

// 🔴 剛好三個呼叫點（大圖一次、講者照片一次、相簿的 map 內一次）——多一個就代表
// 有地方在上面三條守衛之外又呼叫了一次 imageFor()，那一處很可能沒有守衛。
check(
  "剛好三處呼叫 imageFor()（大圖、講者照片、相簿各一個呼叫點；多一處代表有地方漏了守衛）",
  (detailCode.match(/imageFor\(/g) ?? []).length,
  3,
);

checkFalse("路由沒有 import 任何 @/assets 圖片", /from "@\/assets\//.test(detailCode));
checkFalse("head() 沒有硬塞 og:image", /"og:image"/.test(detailCode));
// 對照組：imageFor 這支函式本身還在，斷言才有意義（不是因為函式被刪掉才「沒呼叫」）。
checkTrue(
  "imageFor 仍然存在於 src/lib/images.ts",
  /export function imageFor/.test(stripTs(readFile("src/lib/images.ts"))),
);
checkTrue("而列表頁仍然用得到它", /imageFor\(/.test(indexCode));

// =============================================================================
// [5b] 三張圖的 loading／width／height（2026-09 前台載入速度優化）
// =============================================================================
console.log("\n[5b] 大圖／講者照片／相簿——lazy 與 width/height");
// 三個 <img> 各自獨立抽出來比對，不用有界視窗的正則猜邊界——比對範圍是「這個
// <img> 標籤本身」，多寬都不會被別的標籤污染，也不會因為屬性順序調整而碎掉。
function imgTagContaining(code, marker) {
  const markerIdx = code.indexOf(marker);
  if (markerIdx === -1) return null;
  const tagStart = code.lastIndexOf("<img", markerIdx);
  const tagEnd = code.indexOf("/>", markerIdx);
  if (tagStart === -1 || tagEnd === -1) return null;
  return code.slice(tagStart, tagEnd + 2);
}

const coverImg = imgTagContaining(detailCode, 'imageFor(event.imageKey, "")');
const speakerImg = imgTagContaining(detailCode, 'imageFor(event.speaker.imageKey, "")');
const galleryImg = imgTagContaining(detailCode, "imageFor(key,");

checkTrue(
  "三個 <img> 標籤都抽得到（大圖／講者照片／相簿）",
  coverImg !== null && speakerImg !== null && galleryImg !== null,
);

// 大圖：**不** lazy。這通常是頁面第一塊視覺內容（LCP 候選），lazy 會延後它，
// 跟「載入速度優化」的目標反著走——這是刻意的判斷，不是漏加，所以要有一條
// 斷言把它釘住，否則哪天有人「順手」幫大圖也補一個 loading="lazy" 不會被發現。
checkFalse(
  '大圖沒有 loading="lazy"（它通常是 LCP 候選，lazy 會延後它）',
  /loading=/.test(coverImg ?? ""),
);
// 大圖：原比例完整顯示（封面常是有字的海報，裁切會切掉標題）。不能回到
// aspect-[21/9] + object-cover 的通欄橫幅，也不寫死 width/height 比例佔位。
checkTrue(
  "大圖照原比例完整顯示（h-auto + object-contain + max-h-[80vh]）",
  /h-auto/.test(coverImg ?? "") &&
    /object-contain/.test(coverImg ?? "") &&
    /max-h-\[80vh\]/.test(coverImg ?? ""),
);
checkFalse(
  "大圖不再用 object-cover，頁面也沒有 aspect-[21/9] 裁切框",
  /object-cover/.test(coverImg ?? "") || detailCode.includes("aspect-[21/9]"),
);

// 講者照與相簿：頁面下半部，補 lazy 是零風險、見效最快的一刀。
checkTrue('講者照有 loading="lazy"', /loading="lazy"/.test(speakerImg ?? ""));
checkTrue(
  "講者照有 width/height",
  /width=\{160\}/.test(speakerImg ?? "") && /height=\{160\}/.test(speakerImg ?? ""),
);
checkTrue('相簿每張圖有 loading="lazy"', /loading="lazy"/.test(galleryImg ?? ""));
checkTrue(
  "相簿每張圖有 width/height",
  /width=\{600\}/.test(galleryImg ?? "") && /height=\{600\}/.test(galleryImg ?? ""),
);

// =============================================================================
// [6] 場次區：空的時候要有文案，不是整塊消失
// =============================================================================
console.log("\n[6] 場次區與空狀態");
// 這一期起這一頁同時用得到唯讀的 SessionList 與選得動的 SessionPicker（見 [8]），
// 兩個都從同一個檔案來 —— 所以這裡釘的是「SessionList 在這一行 import 裡」，
// 不是整行逐字相等。
checkTrue(
  "路由 import 了 SessionList",
  /import \{[^}]*\bSessionList\b[^}]*\} from "@\/components\/shop\/SessionPicker";/.test(
    detailCode,
  ),
);
checkTrue("路由真的渲染 <SessionList", /<SessionList\b/.test(detailCode));
// 沒有商品就沒有場次（event_sessions 掛的是 product_id），但那時候要傳空陣列
// 讓元件畫空狀態，不是把整塊拿掉。
// ⚠️ 這一條原本釘的是整行字面值（含結尾的 ` />`）。0029 給 <SessionList> 加了第二個
//    prop，那一行被 prettier 拆成多行 —— 於是這條斷言紅了，而它要守的東西（沒有商品
//    時仍然傳空陣列）一個字都沒變。釘整行字面值就是這個 repo 反覆出過的
//    「釘死單一形狀，重排之後失去覆蓋（或誤報）」，所以改成釘**那個 prop 的值**。
//    `[^<]` 保證比對不會跨到下一個 JSX 元素上（每個元素都以 `<` 開頭）。
checkTrue(
  "沒有商品時仍然傳空陣列進去",
  /<SessionList\b[^<]*?sessions=\{booking\.product\?\.sessions \?\? \[\]\}/.test(detailCode),
);
// 0029：名額顯示是逐場活動的決定，活動頁的三個場次區塊都要吃到它。
checkTrue(
  "沒有商品時，名額旗標退回「顯示」（＝ 0029 的欄位預設，也是既有行為）",
  /<SessionList\b[^<]*?showSeatsRemaining=\{booking\.product\?\.showSeatsRemaining \?\? true\}/.test(
    detailCode,
  ),
);
check(
  // 0036：分母加上 <PlanPicker>——它跟 SessionPicker/SessionList 一樣吃同一個
  // showSeatsRemaining 旗標（沿用場次層級的決定，方案沒有自己的開關），少傳
  // 一樣是「有一塊不吃這個開關」。
  "活動頁的場次／方案區塊全都傳了 showSeatsRemaining（少一個就有一塊不吃這個開關）",
  (detailCode.match(/showSeatsRemaining=\{/g) || []).length,
  (detailCode.match(/<(SessionPicker|SessionList|PlanPicker)\b/g) || []).length,
);
checkTrue(
  "有商品時傳的是商品那一份，不是寫死 true",
  /<SessionPicker\b[^<]*?showSeatsRemaining=\{product\.showSeatsRemaining\}/.test(detailCode) &&
    /<SessionList\b[^<]*?showSeatsRemaining=\{product\.showSeatsRemaining\}/.test(detailCode),
);
check(
  "沒有任何一處把旗標寫死成 true 以外的常數（那會讓後台的開關失效）",
  /showSeatsRemaining=\{(true|false)\}/.test(detailCode.replace(/\?\? true\}/g, "?? X}")),
  false,
);
checkTrue("SessionPicker.tsx 匯出 SessionList", /export function SessionList\(/.test(pickerCode));
checkTrue("SessionList 有空狀態文案", /COPY\.noPublicSessions/.test(pickerCode));
checkFalse(
  "SessionList 不是空的時候 return null",
  /sessions\.length === 0[\s\S]{0,80}return null/.test(pickerCode),
);
// 不可以自己再算一次剩餘名額，也不可以自己再寫一份日期格式 —— 兩份就是
// 「商品頁與活動頁對同一場活動顯示不同的數字」。
checkTrue(
  "SessionList 走共用的 remainingForSession",
  /remainingForSession\(session\)/.test(pickerCode),
);
checkFalse("路由沒有自己算剩餘名額", /remainingForSession/.test(detailCode));
checkFalse("路由沒有自己寫日期格式", /formatSessionWhen/.test(detailCode));
checkFalse("路由沒有自己 map 場次", /sessions\.map\(/.test(detailCode));
// 既有的 SessionPicker 不可以被這一期換掉 —— /shop/$slug 還在用它。
checkTrue("SessionPicker 本人還在", /export function SessionPicker\(/.test(pickerCode));

// =============================================================================
// [7] 報名按鈕：導過去，四種狀態都有畫面
// =============================================================================
console.log("\n[7] 報名按鈕");
checkTrue("讀 events.registration_type", /registrationType/.test(detailCode));
checkTrue("external 走 external_url", /kind: "external"; href: string/.test(detailCode));
// 🔴 目的地在這一期換了：原本是「導到商品頁 /shop/$slug，讓客人在那裡加入購物車」，
//    現在是「就地選場次與人數，直接進 /checkout」。少掉的是商品頁與購物車那兩頁 ——
//    它們對「哪一場、幾個人」沒有貢獻任何決定。第二個入口為什麼安全，見 [8]。
checkTrue("internal 直接導到 /checkout", /to="\/checkout"/.test(detailCode));
checkFalse("不再繞道商品頁（那一步就是這一期要拿掉的）", /to="\/shop\/\$slug"/.test(detailCode));
checkTrue(
  "internal 拿到的是整件商品（要靠它問場次與名額）",
  /kind: "internal"; product: ShopProduct/.test(detailCode),
);
// 接不到商品時不可以導去一個會 404 的網址，要顯示狀態。
checkTrue("接不到商品時顯示「報名尚未開放」", /t\(PAGE\.notOpen\)/.test(detailCode));
// 「問不到」與「沒有」是兩件事：讀取失敗時說「尚未開放」是一句還不知道真假的話。
checkTrue("讀取失敗時另有文案", /t\(PAGE\.registrationUnavailable\)/.test(detailCode));
checkTrue(
  "unavailable 才走 unavailable 文案，其餘走 closed",
  /booking\.unavailable \? \{ kind: "unavailable" \} : \{ kind: "closed" \}/.test(detailCode),
);
checkTrue(
  "external_url 是空字串時也不生一個空連結",
  /return href \? \{ kind: "external", href \} : \{ kind: "closed" \};/.test(detailCode),
);
// 商品反查走 products.slug（= event-<events.slug>）這條真連結。
//
// 0026 之前這裡是 (source_type='event', source_id=events.id) 加 `.limit(1)`：能用，
// 但資料庫不保證一場活動只有一件商品，所以「賣哪一件」取決於排序運氣。0026 給了
// products.slug 這條唯一索引上的等值查詢，就沒有「取第一件」這回事了。
checkTrue(
  "shop.ts 有 fetchActiveProductForEventSlug",
  /export async function fetchActiveProductForEventSlug/.test(shopCode),
);
// 它委派給 fetchActiveProductBySlug()，所以真正要驗的查詢形狀在後者身上。
const bySlugProductBody = stripTs(fnBody(readFile("src/lib/shop.ts"), "fetchActiveProductBySlug"));
checkTrue("切得出 fetchActiveProductBySlug 的本體", bySlugProductBody.length > 300);
checkTrue("用 products.slug 等值查詢", /\.eq\("slug", slug\)/.test(bySlugProductBody));
const forEventSlugBody = stripTs(
  fnBody(readFile("src/lib/shop.ts"), "fetchActiveProductForEventSlug"),
);
checkTrue(
  "反查走 eventProductSlug()，不是就地拼字串",
  /fetchActiveProductBySlug\(eventProductSlug\(eventSlug\)\)/.test(forEventSlugBody),
);
checkTrue("只拿上架中的商品", /\.eq\("status", "active"\)/.test(bySlugProductBody));
// products.slug 有唯一索引（0004），所以這裡 maybeSingle() 才是對的形狀 ——
// limit(1) 的意思是「可能有很多列，取第一列」，那已經不再成立。
checkTrue("唯一索引上的查詢用 maybeSingle()", /maybeSingle\(\)/.test(bySlugProductBody));
checkFalse("沒有留著 limit(1)", /\.limit\(1\)/.test(bySlugProductBody));
// 用回傳那一列的 event.slug 問，不是拿 params.slug 直接問：兩者今天一定相等，但
// 拿 DB 回傳的那一列當權威，之後多一層網址正規化也不會安靜查錯東西。
checkTrue(
  "loader 用 event.slug 去找商品",
  /fetchActiveProductForEventSlug\(event\.slug\)/.test(detailCode),
);
checkFalse(
  "沒有拿 params.slug 直接找商品",
  /fetchActiveProductForEventSlug\(params\.slug\)/.test(detailCode),
);

// =============================================================================
// [8] 第二個結帳入口存在了，但沒有第二份邏輯
// =============================================================================
console.log("\n[8] 第二個入口沒有帶來第二份邏輯");
//
// ── 這一段為什麼從「不准有第二個入口」改成現在這樣 ─────────────────────────
// 這裡原本守的是「這一頁不可以自己做結帳入口」，理由寫在路由檔裡：「結帳是一條真管線
// （cartInputFor → cart → checkout → 座位預留 → 金流 → 發票），而它的數量上限取的是
// **選中那一場**的剩餘。第二個入口就是第二份那段邏輯，兩份遲早會長歪成『活動頁讓你買
// 5 個位子、那一場只剩 1 個』。」
//
// **那個擔心沒有被推翻，是被消掉了。** 這一期真的加了入口，但：
//   · 上限不在這一頁 —— 一律 directSeatLimit() → cartInputFor().limit，與購物車行
//     同一行程式碼；這一頁連 remainingForSession 都沒有 import。
//   · 下單不在這一頁 —— 按鈕只是一個帶參數的 <Link to="/checkout">，訂單仍然由
//     /checkout 走 placeOrder() → createOrder()。
// 所以下面守的變成這兩件事本身。夾出來的數字對不對是 scripts/direct-checkout-selftest.mjs
// 真的跑一次在驗的（兩個名額不同的場次），這裡只守形狀。
//
// 🔴 上限只有一份
checkTrue("上限問共用的 directSeatLimit()", /directSeatLimit\(/.test(detailCode));
// 0036：同一條規矩延伸到方案——remainingForPlan／isPlanAvailable／planInSaleWindow
// 只能住在 PlanPicker.tsx 裡（跟 remainingForSession 只能住在 SessionPicker.tsx
// 是同一個理由），這裡也不准出現 units_taken／seats_per_unit 這類方案專屬的欄位名。
for (const forbidden of [
  "remainingForSession",
  "remainingFor(",
  "seatsTaken",
  "capacity",
  "remainingForPlan",
  "isPlanAvailable",
  "planInSaleWindow",
  "unitsTaken",
  "seatsPerUnit",
]) {
  checkFalse(
    `路由沒有自己算名額（${forbidden}）`,
    new RegExp(forbidden.replace(/[()]/g, "\\$&")).test(detailCode),
  );
}
// 🔴 沒選場次時，數量上限不可以退回商品層級的跨場次最大值 —— 那正是那個 bug。
checkTrue(
  // 0036：多了第三個參數 selectedPlan，見 direct-checkout.ts 的 directSeatLimit()。
  "沒選場次時上限鎖成 1，不是跨場次最大值",
  /selectedSession \? directSeatLimit\(product, selectedSession, selectedPlan\) : 1/.test(
    detailCode,
  ),
);
// 🔴 下單管線只有一條
for (const forbidden of ["placeOrder", "createOrder", "idempotency", "reserve_session_seat"]) {
  checkFalse(`路由沒有第二條下單管線（${forbidden}）`, new RegExp(forbidden).test(detailCode));
}
// 🔴 這一頁仍然不碰購物車 store：它一個位元組都不寫進 localStorage。
for (const forbidden of ["useCart", "addItem", "cartInputFor"]) {
  checkFalse(`路由沒有用到 ${forbidden}`, new RegExp(`\\b${forbidden}\\b`).test(detailCode));
}
checkFalse("路由沒有 import @/lib/cart", /from "@\/lib\/cart"/.test(detailCode));
checkFalse("路由沒有 localStorage", /localStorage/.test(detailCode));
// ⚠️ 參加者姓名／電話不可以出現在這一頁（它會被寫進網址）——  與 cart.ts 檔頭同一條。
checkFalse("路由不經手參加者資料", /participant|Participant/.test(detailCode));
// 對照組：既有的「商品頁 → 購物車」那條路還在，上面那幾條否定斷言才有意義
// （不是因為 cartInputFor 這個東西被刪掉了才「沒用到」）。
checkTrue(
  "對照組：cartInputFor 仍然活著，而且 shop.$slug.tsx 還在用",
  /cartInputFor\(/.test(stripTs(readFile("src/routes/shop.$slug.tsx"))),
);
checkTrue(
  "對照組：直接結帳的上限也是走 cartInputFor",
  /cartInputFor\(/.test(stripTs(readFile("src/lib/direct-checkout.ts"))),
);

// =============================================================================
// [9] 三語文案：en 要真的是英文
// =============================================================================
console.log("\n[9] 三語文案");
checkTrue("PAGE 是頂層靜態常數", /^const PAGE = \{/m.test(detailCode));
checkTrue("有呼叫 useDocumentMeta", /useDocumentMeta\(\{/.test(detailCode));
const enValues = [...detailCode.matchAll(/\ben:\s*"([^"]*)"/g)].map((m) => m[1]);
checkTrue("找得到 en 字面值（至少 8 句）", enValues.length >= 8);
const CJK = /[぀-ヿ一-鿿]/;
for (const v of enValues) {
  checkFalse(`en 沒有塞中日文字 → "${v.slice(0, 32)}"`, CJK.test(v));
  checkTrue(`en 不是空字串 → "${v.slice(0, 32)}"`, v.trim().length > 0);
}
const zhValues = [...detailCode.matchAll(/\bzh:\s*"([^"]*)"/g)].map((m) => m[1]);
check("zh 與 en 句數一樣多", zhValues.length, enValues.length);
for (const v of zhValues) checkTrue(`zh 真的是中文 → "${v.slice(0, 20)}"`, CJK.test(v));
// description 是這一期才第一次有人渲染的欄位（0001 的欄位註解自承 "not rendered
// by any route yet"），而它是後台的多行輸入 —— 換行要留著。
checkTrue(
  "description 用 whitespace-pre-line 渲染",
  /whitespace-pre-line[\s\S]{0,200}t\(event\.description\)/.test(detailCode),
);

// =============================================================================
// [10] 列表頁連得到詳情頁；沒有偷加 migration
// =============================================================================
console.log("\n[10] 入口與禁區");
checkTrue("列表頁連到 /events/$slug", /to="\/events\/\$slug"/.test(indexCode));
// 🔴 列表頁必須帶 **e.slug**，不是 e.id。0026 之前兩者永遠相等，所以帶 id 是對的；
// 0026 之後代稱可以被改掉，那一刻起用 id 連出去的每一條連結都會 404，而且是站內
// 自己連出去的 404 —— 比外部連結失效更難發現，因為沒有人會回報自家列表頁。
checkTrue("列表頁帶的是 events.slug（不是 id）", /params=\{\{ slug: e\.slug \}\}/.test(indexCode));
checkFalse("列表頁沒有留著 slug: e.id", /params=\{\{ slug: e\.id \}\}/.test(indexCode));
// 🔴 這一條原本是 checkTrue（「列表頁仍保留外部連結」），2026-09 反轉了。
//
// events.external_url 在正式庫七場活動裡**有五場還是 https://example.com/event-N**
// —— 0001 的種子資料，從未替換。也就是那顆「前往活動網站」多半是把客人送去一個
// 不存在的地方。活動詳情頁存在之後，站內那一頁本來就是說得最清楚的地方。
//
// 反轉方向要說清楚：這不是「放寬」。原本守的是「不要弄丟外部連結」，現在守的是
// 「列表頁不准再有那顆按鈕」—— 兩者都是精確的、都會因為改回去而轉紅。真的有
// 外部售票連結要顯示時，那是詳情頁的決定（events.$slug.tsx 仍然有那條路）。
checkFalse("🔴 列表頁不再有「前往活動網站」的外部連結", /href=\{e\.externalUrl\}/.test(indexCode));
checkFalse("列表頁也沒有改用別的寫法連出去", /ui\.buttons\.toEvent/.test(indexCode));

const migrations = readdirSync(join(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
// 這兩條原本是「這一期完全不動資料庫」的凍結宣告（0024／0025 當時都還沒套上正式庫）。
// 0026 這一期就是來動資料庫的，所以凍結解除 —— 但**不是刪掉**，而是換成兩條不會過期的
// 結構斷言：編號連續（有人同時開兩支 0026 會抓到）、而且沒有人回頭改 0025。
const migNums = migrations.map((f) => Number(f.slice(0, 4)));
check(
  "migration 編號從 0001 起連續、不重複",
  migNums.join(","),
  migNums.map((_, i) => i + 1).join(","),
);
checkTrue(
  "0025_event_speaker.sql 還在原位（沒有人回頭改編號）",
  migrations[24] === "0025_event_speaker.sql",
);
// src/server/repos/events.ts 那套「欄位不存在就降級」的過渡程式碼在 0026 這一期
// 刪掉了（0025 已經套上正式庫）。這兩條反過來守它**不會被複製回來** —— 降級路徑
// 會把「migration 沒套上」變成一個安靜的次等狀態，而安靜正是上一次沒人發現的原因。
const repoCode = readFile("src/server/repos/events.ts");
checkFalse("repos/events.ts 沒有 speaker 降級旗標了", /speakerColumnPresent/.test(repoCode));
checkFalse("repos/events.ts 沒有 COLUMNS_BASE 了", /COLUMNS_BASE/.test(repoCode));

// -----------------------------------------------------------------------------
// 收尾
// -----------------------------------------------------------------------------
console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed\n`));
  process.exit(0);
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed\n`));
  process.exit(1);
}
