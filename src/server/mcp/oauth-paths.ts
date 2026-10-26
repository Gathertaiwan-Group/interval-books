/**
 * src/server.ts 在模組載入時就要知道的 OAuth 端點路徑。獨立成一個零 import 的小檔，
 * 讓 server entry 不必在載入時就把 oauth.ts（及它 dynamic import 的 auth／service role）
 * 拉進來。值與 oauth-core.ts 的 OAUTH_*_PATH 相同（mcp-oauth-selftest 會對帳）。
 */
export const OAUTH_ENDPOINT_PATHS: readonly string[] = [
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
];
