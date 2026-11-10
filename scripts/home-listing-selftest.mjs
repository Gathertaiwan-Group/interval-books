#!/usr/bin/env node
/**
 * home-listing-selftest.mjs —— 首頁「近期活動與策旅」（2026-11-10 手機版改版）
 *
 *   [純函式] src/lib/home-listing.ts listingFactsFor()：
 *              · 票價照 products.price；0 = 免費；讀不懂 → null（卡片不印）
 *              · 只看「開放中、尚未開始」的場次；全部沒名額才是額滿
 *              · 「最後 N 位」只在 show_seats_remaining 開著、且剩 ≤ 門檻時出現
 *   [靜態]   首頁區塊順序：近期活動與策旅緊接在 hero 之後、在「讀．聚．行」之前
 *            首頁 listing 與其他讀取同一個 Promise.all；手機橫滑只用 max-md: 前綴
 *
 * 不碰任何資料庫（@/lib/supabase 換成 null 的替身）。
 */
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/home-listing-selftest.mjs";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "@/lib/supabase") {
      return {
        url: "data:text/javascript,export const supabase = null;",
        shortCircuit: true,
      };
    }
    if (spec.startsWith("@/")) {
      return {
        url: pathToFileURL(join(ROOT, "src", `${spec.slice(2)}.ts`)).href,
        shortCircuit: true,
      };
    }
    return next(spec, ctx);
  },
});

let pass = 0;
let fail = 0;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? green("✓") : red("✗")} ${name}${ok ? "" : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`}`,
  );
}
const readFile = (rel) => readFileSync(join(ROOT, rel), "utf8");

const { listingFactsFor, fetchListingFacts, LOW_SEATS_THRESHOLD } = await import(
  pathToFileURL(join(ROOT, "src/lib/home-listing.ts")).href
);

const NOW = Date.parse("2026-11-10T04:00:00Z");
const future = (d) => `2026-12-${String(d).padStart(2, "0")}T11:30:00+00:00`;
const session = (over) => ({
  starts_at: future(1),
  capacity: 20,
  seats_taken: 0,
  status: "open",
  ...over,
});

// ── 票價 ────────────────────────────────────────────────────────────────
check("有價格、沒場次 → 只印價格", listingFactsFor({ price: 1000, event_sessions: [] }, NOW), {
  price: 1000,
  soldOut: false,
  fewLeft: null,
});
check("價格 0 照樣回傳（畫面印「免費」）", listingFactsFor({ price: 0 }, NOW)?.price, 0);
check("價格讀不懂 → null", listingFactsFor({ price: "1000" }, NOW), null);
check("負價格 → null", listingFactsFor({ price: -1 }, NOW), null);

// ── 額滿 ────────────────────────────────────────────────────────────────
check(
  "所有未來場次都滿 → 額滿",
  listingFactsFor(
    {
      price: 500,
      event_sessions: [
        session({ seats_taken: 20 }),
        session({ starts_at: future(8), seats_taken: 25 }),
      ],
    },
    NOW,
  ).soldOut,
  true,
);
check(
  "還有一場有位子 → 不是額滿",
  listingFactsFor(
    { price: 500, event_sessions: [session({ seats_taken: 20 }), session({ seats_taken: 3 })] },
    NOW,
  ).soldOut,
  false,
);
check(
  "已開始的場次不算（滿的未來場次＋有位子的過去場次 → 額滿）",
  listingFactsFor(
    {
      price: 500,
      event_sessions: [
        session({ seats_taken: 20 }),
        session({ starts_at: "2026-11-01T11:30:00+00:00", seats_taken: 0 }),
      ],
    },
    NOW,
  ).soldOut,
  true,
);
check(
  "closed 場次不算",
  listingFactsFor({ price: 500, event_sessions: [session({ status: "closed" })] }, NOW),
  { price: 500, soldOut: false, fewLeft: null },
);

// ── 最後 N 位 ───────────────────────────────────────────────────────────
check(
  "show_seats_remaining 關著 → 不印剩幾位",
  listingFactsFor({ price: 500, event_sessions: [session({ seats_taken: 18 })] }, NOW).fewLeft,
  null,
);
check(
  "開著且剩 2 → 最後 2 位",
  listingFactsFor(
    { price: 500, show_seats_remaining: true, event_sessions: [session({ seats_taken: 18 })] },
    NOW,
  ).fewLeft,
  2,
);
check(
  `剩超過門檻（${LOW_SEATS_THRESHOLD}）→ 不印`,
  listingFactsFor(
    {
      price: 500,
      show_seats_remaining: true,
      event_sessions: [session({ seats_taken: 20 - LOW_SEATS_THRESHOLD - 1 })],
    },
    NOW,
  ).fewLeft,
  null,
);
check(
  "多場取最多名額那一場（與 remainingFor 同定義）",
  listingFactsFor(
    {
      price: 500,
      show_seats_remaining: true,
      event_sessions: [session({ seats_taken: 19 }), session({ seats_taken: 16 })],
    },
    NOW,
  ).fewLeft,
  4,
);
check("沒有 Supabase → 空物件（不拋錯）", await fetchListingFacts(), {});

// ── 首頁靜態檢查 ────────────────────────────────────────────────────────
const home = readFile("src/routes/index.tsx");
const posHeroEnd = home.indexOf("{t(HOME.heroCaption)}");
const posUpcoming = home.indexOf('id="upcoming"');
const posPillars = home.indexOf('aria-labelledby="home-pillars"');
const posArchive = home.indexOf('aria-labelledby="home-archive"');
const posPast = home.indexOf("<PastShelf");
const posVisit = home.indexOf('aria-labelledby="home-visit"');
// 2026-11-10 業主精簡 hero：只留地點 eyebrow、定位句大標（逗號後換行）與首圖
check(
  "hero 不再印小字店名／說明段落／按鈕／斜體句",
  [
    "HOME.brandLine",
    "HOME.lede",
    "HOME.ctaPrimary",
    "HOME.ctaSecondary",
    'p.block("hero.titleSub"',
  ].filter((k) => home.includes(k)),
  [],
);
check(
  "hero 大標用 splitAtComma 在逗號後換行",
  home.includes('splitAtComma(t(p.block("home.headline", HOME.headline)))'),
  true,
);
check(
  "hero 大標三語是業主指定文案",
  [
    "以書店為載體，讓更多人認識台灣的美好。",
    "A bookstore as a vessel, sharing the good things of Taiwan.",
    "本屋を器に、台湾の素晴らしさを届ける。",
  ].every((s) => home.includes(s)),
  true,
);
// 2026-11-10 收尾段（休止符＋INTERVAL）搬到 /about：故事之後、「我們做的事」之前
check(
  "首頁不再渲染收尾段",
  ["<RestMark", "<IntervalCoda", "closingBody", 'p.block("hero.intro"'].filter((k) =>
    home.includes(k),
  ),
  [],
);
{
  const about = readFile("src/routes/about.tsx");
  const story = about.indexOf('data-testid="about-story"');
  const coda = about.indexOf("<IntervalCoda");
  const work = about.indexOf('data-testid="about-work"');
  check(
    "/about 的店名由來在故事之後、我們做的事之前",
    story > 0 && coda > story && coda < work,
    true,
  );
  check(
    "/about 的句子仍讀 pages/'index' 的 hero.intro",
    about.includes('pageText(indexPage).block("hero.intro", INTERVAL_COPY.motto)'),
    true,
  );
  const coda2 = readFile("src/components/IntervalCoda.tsx");
  check(
    "英文不再把 interval 說成休止符",
    coda2.includes("An interval is the pause between two acts") &&
      !coda2.includes("INTERVAL is the rest in a musical score"),
    true,
  );
  check("日文不再寫「INTERVAL は楽譜の休符のこと」", coda2.includes("楽譜の休符のこと"), false);
}
check("hero 下方的「三個數字」已拿掉", /HOME\.fact[A-Z]/.test(home), false);
check("近期活動與策旅在 hero 之後", posHeroEnd > 0 && posUpcoming > posHeroEnd, true);
check("近期活動與策旅在地方刊物典藏之前", posUpcoming > 0 && posUpcoming < posArchive, true);
// 2026-11-10 業主：讀．聚．行移到回顧之後；同日「來小時光坐坐」整塊拿掉 → 讀．聚．行是首頁最後一區
check("「讀．聚．行」在回顧之後", posPast > 0 && posPillars > posPast, true);
check("首頁不再有「來小時光坐坐」來訪資訊區塊", posVisit, -1);
check(
  "首頁不再嵌地圖、不再有 #visit 錨點",
  ["map.embed", "map.link", 'href="#visit"', "HOME.visit"].filter((k) => home.includes(k)),
  [],
);
check(
  "「讀．聚．行」之後沒有別的區塊（直接接頁尾）",
  home.slice(posPillars).split("<section").length - 1,
  0,
);
check(
  "listing 與其他讀取同一個 Promise.all",
  /Promise\.all\(\[[^\]]*fetchListingFacts\(\)/.test(home),
  true,
);
check(
  "手機橫滑的 class 全部帶 max-md: 前綴（桌機交回 featureLayout）",
  (() => {
    const m = home.match(/function railFor[\s\S]*?\n}\n/);
    if (!m) return false;
    const classes = [...m[0].matchAll(/"([^"]*)"/g)]
      .flatMap((x) => x[1].split(/\s+/))
      .filter(Boolean);
    return classes.length > 0 && classes.every((c) => c.startsWith("max-md:"));
  })(),
  true,
);

console.log("\n────────────────────────────────────────────────────");
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
if (fail === 0) {
  console.log(green(`✓ 全部通過：${pass} passed, 0 failed`));
} else {
  console.log(red(`✗ 有失敗：${pass} passed, ${fail} failed`));
  process.exitCode = 1;
}
