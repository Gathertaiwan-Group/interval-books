/**
 * MCP OAuth 同意頁（/oauth/authorize）的兩支 server fn。實作在
 * src/server/mcp/oauth-consent.ts；這裡只做輸入形狀檢查與 dynamic import（service role
 * 不會被拉進瀏覽器 bundle）。
 *
 * 兩支都是 POST：網址裡的授權參數（state、code_challenge…）不該出現在 GET 的 query 裡被
 * 任何一層記下來，回應也不可以被快取。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const queryInput = z.object({ query: z.string().max(8000) });

export const prepareOAuthAuthorize = createServerFn({ method: "POST" })
  .inputValidator(queryInput)
  .handler(async ({ data }) => {
    const { prepareAuthorize } = await import("@/server/mcp/oauth-consent");
    return prepareAuthorize(data.query);
  });

export const decideOAuthAuthorize = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      query: z.string().max(8000),
      csrf: z.string().max(200),
      allow: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    const { decideAuthorize } = await import("@/server/mcp/oauth-consent");
    return decideAuthorize(data.query, data.csrf, data.allow);
  });
