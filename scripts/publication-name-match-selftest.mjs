#!/usr/bin/env node
/**
 * publication-name-match-selftest.mjs —— src/lib/admin/publication-name-match.ts 的自檢
 *
 * 2026-10-25 起後台商品頁不再讀 `publication_listing_candidates` view（每次約 1 秒），改在程式裡
 * 用已經抓回來的候選品項與刊物比對。比對規則必須跟 view 的 SQL 一字不差（0015：刻意不做模糊
 * 比對，猜錯的連結會讓客人買到另一本刊物）。
 *
 *   [1] 固定案例（直接 import 產線程式碼）：大小寫、全形、標點、空白、NULL、空字串、zh/ja 兩語、
 *       重複列、順序。
 *   [2] 跟真的 Postgres 比（選用）：PUBLICATION_MATCH_PG_URL=postgres://… 時，把 [1] 的字串丟給
 *       view 用的那一句 `regexp_replace(lower(x), '[^[:alnum:]]', '', 'g')`，逐字比對正規化結果，
 *       並用同一份 cross join 條件算出配對，跟程式的結果比。只跑 SELECT 常值，不碰任何表。
 *   [3] 跟正式庫比（選用、唯讀）：PUBLICATION_MATCH_LIVE=1 且有 SUPABASE_URL／
 *       SUPABASE_SERVICE_ROLE_KEY 時，讀 view 本身與兩張來源表（只有 GET），比對兩邊的列是不是
 *       同一個集合（含重複次數），並對來源資料裡出現的每一個字元用 Postgres 的 `~` 驗證
 *       [[:alnum:]] 分類與程式一致。
 *
 * 執行：node scripts/publication-name-match-selftest.mjs（或 npm test；[2][3] 沒設環境變數就略過）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/publication-name-match-selftest.mjs";
const M = await import(pathToFileURL(join(ROOT, "src/lib/admin/publication-name-match.ts")).href);

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail += 1;
    console.log(
      `  \x1b[31m✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}\x1b[0m`,
    );
  }
}
const skip = (label) => console.log(`  \x1b[33m- 略過：${label}\x1b[0m`);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 固定案例");
const N = M.normalizeListingName;
check("NULL → NULL", N(null), null);
check("undefined（JSON 沒有這個 key）→ NULL", N(undefined), null);
check("ASCII 大寫轉小寫", N("ABC def"), "abcdef");
check("全形英文轉小寫、保留", N("ＡＢＣ"), "ａｂｃ");
check("全形數字是 alnum（正式庫實測）", N("第１２期"), "第１２期");
check("中日文是 alnum", N("海の声 · 東北風"), "海の声東北風");
check("長音符ー、々 是 alnum（正式庫實測）", N("コーヒー々"), "コーヒー々");
check(
  "標點與空白全部拿掉（含全形、中黑點）",
  N("《地方・誌》：第 1 期！（2025）、「春」"),
  "地方誌第1期2025春",
);
check("全形空白拿掉", N("小　時光"), "小時光");
check("emoji 拿掉", N("書🌊店"), "書店");
check("整串都是標點 → 空字串（不是 NULL）", N("——！？"), "");
check("空字串 → 空字串", N(""), "");

const J = M.jsonbText;
check("->> 字串原樣", J({ zh: "海" }, "zh"), "海");
check("->> 沒有 key → NULL", J({ zh: "海" }, "ja"), null);
check("->> JSON null → NULL", J({ ja: null }, "ja"), null);
check("->> 標題本身是 NULL → NULL", J(null, "zh"), null);
check("->> 數字取 JSON 文字", J({ zh: 12 }, "zh"), "12");

const cand = (id, name) => ({
  inv_product_id: id,
  name,
  selling_price: 100,
  stock_quantity: 1,
  pack_size: 1,
  barcode: null,
});
const FIX_CANDIDATES = [
  cand("c1", "東北風"),
  cand("c2", "東北風 (二手)"),
  cand("c3", "Umi no Koe"),
  cand("c4", "UMI-NO-KOE"),
  cand("c5", "——"),
  cand("c6", null),
  cand("c7", "海想知道"),
  cand("c7", "海想知道"), // 同一個品項在 view 裡出現兩列 → 結果也兩列
  cand("c8", "ＡＢＣ通信"),
];
const FIX_PUBLICATIONS = [
  { id: "p1", title: { zh: "東北風", ja: "東北風" } }, // zh、ja 都中 → 只算一次
  { id: "p2", title: { zh: "海の声", ja: "umi no koe" } }, // 只有 ja 中，大小寫與標點不同
  { id: "p3", title: { zh: "！！", ja: null } }, // 正規化後是 '' → 跟 c5 的 '' 相等（SQL 的 '' = '' 是 true）
  { id: "p4", title: { zh: null } }, // NULL 不等於任何東西（包括 c6 的 NULL）
  { id: "p5", title: { zh: "海想知道" } },
  { id: "p6", title: { zh: "abc通信" } }, // 半形 abc ≠ 全形 ａｂｃ（不做相容性正規化）
  { id: "p7", title: null },
];
const got = M.matchPublicationNames(FIX_CANDIDATES, FIX_PUBLICATIONS).map(
  (r) => `${r.publication_id}:${r.inv_product_id}`,
);
check("配對結果（順序：刊物照傳入、品項照傳入）", got, [
  "p1:c1",
  "p2:c3",
  "p2:c4",
  "p3:c5",
  "p5:c7",
  "p5:c7",
]);
check("「東北風 (二手)」不算同名（不做模糊比對）", got.includes("p1:c2"), false);
check(
  "回傳欄位與 view 相同",
  Object.keys(M.matchPublicationNames(FIX_CANDIDATES, FIX_PUBLICATIONS)[0]).sort(),
  [
    "barcode",
    "inv_product_id",
    "name",
    "pack_size",
    "publication_id",
    "selling_price",
    "stock_quantity",
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 跟真的 Postgres 比（PUBLICATION_MATCH_PG_URL）");
const PG_URL = process.env.PUBLICATION_MATCH_PG_URL;
if (!PG_URL) {
  skip("沒有設 PUBLICATION_MATCH_PG_URL");
} else {
  const lit = (s) =>
    s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;
  const strings = [
    ...new Set(
      [
        ...FIX_CANDIDATES.map((c) => c.name),
        ...FIX_PUBLICATIONS.flatMap((p) => [
          M.jsonbText(p.title, "zh"),
          M.jsonbText(p.title, "ja"),
        ]),
        "ABC def",
        "ＡＢＣ",
        "第１２期",
        "海の声 · 東北風",
        "コーヒー々",
        "《地方・誌》：第 1 期！（2025）、「春」",
        "小　時光",
        "書🌊店",
        "——！？",
        "",
      ].filter((s) => s !== null && s !== undefined),
    ),
  ];
  const sql = `select coalesce(json_agg(json_build_array(s, regexp_replace(lower(s), '[^[:alnum:]]', '', 'g'))), '[]') from (values ${strings
    .map((s) => `(${lit(s)})`)
    .join(",")}) v(s)`;
  const { stdout } = await execFileAsync("psql", ["-X", "-q", "-A", "-t", "-d", PG_URL, "-c", sql]);
  const rows = JSON.parse(stdout.trim());
  const bad = rows.filter(([s, n]) => N(s) !== n);
  check(`Postgres 的正規化與程式逐字相同（${rows.length} 個字串）`, bad, []);

  const candVals = FIX_CANDIDATES.map(
    (c, i) => `(${i}, ${lit(c.inv_product_id)}, ${lit(c.name)})`,
  ).join(",");
  const pubVals = FIX_PUBLICATIONS.map(
    (p, i) =>
      `(${i}, ${lit(p.id)}, ${p.title === null ? "NULL" : lit(JSON.stringify(p.title))}::jsonb)`,
  ).join(",");
  const joinSql = `select coalesce(json_agg(x order by pi, ci), '[]') from (
    select p.pi, c.ci, p.id || ':' || c.inv_product_id as x
    from (values ${candVals}) c(ci, inv_product_id, name)
    cross join (values ${pubVals}) p(pi, id, title)
    where regexp_replace(lower(c.name), '[^[:alnum:]]', '', 'g')
        = regexp_replace(lower(p.title ->> 'zh'), '[^[:alnum:]]', '', 'g')
       or regexp_replace(lower(c.name), '[^[:alnum:]]', '', 'g')
        = regexp_replace(lower(p.title ->> 'ja'), '[^[:alnum:]]', '', 'g')
  ) t`;
  const j = await execFileAsync("psql", ["-X", "-q", "-A", "-t", "-d", PG_URL, "-c", joinSql]);
  check("view 的 cross join 條件在 Postgres 上算出同一組配對", JSON.parse(j.stdout.trim()), got);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 跟正式庫比（PUBLICATION_MATCH_LIVE=1，唯讀）");
const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (process.env.PUBLICATION_MATCH_LIVE !== "1" || !U || !K) {
  skip("沒有設 PUBLICATION_MATCH_LIVE=1／SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY");
} else {
  const H = { apikey: K, authorization: `Bearer ${K}` };
  const get = async (path) => {
    const r = await fetch(`${U}/rest/v1/${path}`, { headers: H });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };
  const COLS = "inv_product_id,name,selling_price,stock_quantity,pack_size,barcode";
  // 與 src/server/repos/* 用的查詢一樣（同樣的欄位、排序、上限）。
  const view = await get(`publication_listing_candidates?select=publication_id,${COLS}&limit=2000`);
  const candidates = await get(`inv_listing_candidates?select=${COLS}&order=name.asc&limit=2000`);
  const publications = await get("publications?select=id,title&limit=1000");
  const js = M.matchPublicationNames(candidates, publications);
  const key = (r) =>
    JSON.stringify([
      r.publication_id,
      r.inv_product_id,
      r.name,
      r.selling_price,
      r.stock_quantity,
      r.pack_size,
      r.barcode,
    ]);
  const bag = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].sort();
  };
  check(
    `來源資料沒有被上限截斷（候選 ${candidates.length} < 2000、刊物 ${publications.length} < 1000）`,
    candidates.length < 2000 && publications.length < 1000,
    true,
  );
  check(
    `view 與程式是同一個集合（view ${view.length} 列、程式 ${js.length} 列）`,
    bag(js),
    bag(view),
  );

  // 字元分類：用 `(?=[[:alnum:]])<字元>` 問 Postgres，二分法找出不一致的字元。
  const esc = (c) => {
    const cp = c.codePointAt(0);
    return cp > 0xffff
      ? `\\U${cp.toString(16).padStart(8, "0")}`
      : `\\u${cp.toString(16).padStart(4, "0")}`;
  };
  const count = async (table, col, pattern) => {
    const r = await fetch(
      `${U}/rest/v1/${table}?select=${col.split("->>")[0]}&${col}=match.${encodeURIComponent(pattern)}`,
      { headers: { ...H, Prefer: "count=exact", Range: "0-0" } },
    );
    if (!r.ok) throw new Error(`${table} ${r.status}`);
    return Number(r.headers.get("content-range").split("/")[1]);
  };
  const isAlnum = (c) => N(c) === c;
  const mismatches = [];
  async function probe(table, col, set, alnum) {
    if (!set.length) return;
    const cls = alnum ? "[^[:alnum:]]" : "[[:alnum:]]";
    if ((await count(table, col, `(?=${cls})[${set.map(esc).join("")}]`)) === 0) return;
    if (set.length === 1)
      return void mismatches.push(`${table}.${col} U+${set[0].codePointAt(0).toString(16)}`);
    const h = set.length >> 1;
    await probe(table, col, set.slice(0, h), alnum);
    await probe(table, col, set.slice(h), alnum);
  }
  const sources = [
    ["inv_listing_candidates", "name", candidates.map((c) => c.name)],
    ["publications", "title->>zh", publications.map((p) => M.jsonbText(p.title, "zh"))],
    ["publications", "title->>ja", publications.map((p) => M.jsonbText(p.title, "ja"))],
  ];
  let probed = 0;
  for (const [table, col, vals] of sources) {
    const chars = [
      ...new Set(
        vals
          .filter((v) => typeof v === "string")
          .join("")
          .toLowerCase(),
      ),
    ];
    probed += chars.length;
    await probe(table, col, chars.filter(isAlnum), true);
    await probe(
      table,
      col,
      chars.filter((c) => !isAlnum(c)),
      false,
    );
    // 反向對照：探針真的分得出來（標點那一組在 Postgres 上一定找得到「不是 alnum」的）。
    const non = chars.filter((c) => !isAlnum(c));
    if (non.length) {
      check(
        `${table}.${col}：探針有效（非 alnum 字元確實被 [^[:alnum:]] 找到）`,
        (await count(table, col, `(?=[^[:alnum:]])[${non.map(esc).join("")}]`)) > 0,
        true,
      );
    }
  }
  check(`正式庫資料裡的每一個字元（${probed} 個），[[:alnum:]] 分類與程式一致`, mismatches, []);
}

console.log(`\n${"─".repeat(52)}`);
console.log(`##SELFTEST## file=${SELF} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
