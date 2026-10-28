/**
 * 後台「Claude 連線授權」（/admin/mcp-connections）的 server functions。只有 admin
 * （adminFnMiddleware，見 src/lib/admin/middleware.ts）。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export const listMcpConnections = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listMcpGrants } = await import("@/server/repos/mcp-oauth-grants");
    return await listMcpGrants();
  });

export const revokeMcpConnection = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { revokeMcpGrant } = await import("@/server/repos/mcp-oauth-grants");
    await revokeMcpGrant(data.id);
    return { ok: true };
  });

export const revokeAllMcpConnections = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ confirm: z.literal(true) }))
  .handler(async () => {
    const { revokeAllMcpGrants } = await import("@/server/repos/mcp-oauth-grants");
    return await revokeAllMcpGrants();
  });
