// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// 部署目標為 Vercel（原 Lovable 預設為 cloudflare-module）。
// nitro 預設只在 Lovable sandbox 內啟用，自行部署時必須明確開啟。
// 先宣告成變數再傳：lovable 的 defineConfig 型別只列了 preset／output／cloudflare，
// 但執行期會把整包 nitro 選項原樣展開交給 nitro（含下面的 vercel），物件字面值直接
// 寫進去會被 TS 的多餘屬性檢查擋下。
// BUILD_OUTPUT_DIR：讓自檢把產物 build 到自己專屬的目錄（見 scripts/bundle-admin-leak-selftest.mjs）。
// 預設 .vercel/output 不變——Vercel 的 Build Output API 只認這個位置。
const OUTPUT_DIR = process.env.BUILD_OUTPUT_DIR || ".vercel/output";

const nitro = {
  preset: "vercel",
  // lovable 預設把 output 寫死成 dist/{server,client}，會打亂 Vercel
  // Build Output API v3 要求的 static/ + functions/__server.func/ 結構。
  output: {
    dir: OUTPUT_DIR,
    publicDir: `${OUTPUT_DIR}/static`,
    serverDir: `${OUTPUT_DIR}/functions/__server.func`,
  },
  // 函式機房：東京 hnd1，跟 Supabase（ap-northeast-1）同一區。沒設的話 Vercel
  // 預設美東 iad1，每一次資料庫查詢都要橫跨太平洋（約 150ms 一趟），後台一頁幾次
  // 依序查詢就一秒起跳。寫進 Build Output 的 .vc-config.json，不靠專案設定頁。
  // ⚠️ 不要選 hkg1：Gemini API 不支援香港，AI 功能會全掛。
  vercel: {
    functions: { regions: ["hnd1"] },
  },
};

export default defineConfig({ nitro });
