/**
 * 地方刊物展的 server functions。
 *
 * 全部掛 adminFnMiddleware（不是 staffFnMiddleware）：這一頁編的是網站上的展覽
 * 內容，屬於 CMS，與門市無關。授權邊界在 middleware，不在側欄有沒有顯示這一項 ——
 * 見 src/lib/admin/middleware.ts 的檔頭。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { publicationLinkSchema, publicationSchema } from "@/lib/admin/schemas";

export const listPublications = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listPublications } = await import("@/server/repos/publications");
    return await listPublications();
  });

/**
 * 單一本刊物。後台「商品」頁的上下架開關先用它讀最新的那一列、只改 is_published
 * 再寫回，而不是拿畫面上幾分鐘前的快照整列寫回去（那會蓋掉別人剛存的校稿）。
 */
export const getPublicationById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getPublicationById } = await import("@/server/repos/publications");
    return await getPublicationById(data.id);
  });

/** 同名的進銷存品項，用來把連結對話框裡最可能的選項排到最前面。 */
export const listPublicationNameMatches = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listPublicationNameMatches } = await import("@/server/repos/publications");
    return await listPublicationNameMatches();
  });

export const updatePublication = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(publicationSchema)
  .handler(async ({ data }) => {
    const { updatePublication } = await import("@/server/repos/publications");
    return await updatePublication(data);
  });

export const linkPublicationToInventory = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(publicationLinkSchema)
  .handler(async ({ data }) => {
    const { linkPublicationToInventory } = await import("@/server/repos/publications");
    return await linkPublicationToInventory(data);
  });

export const unlinkPublication = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ publication_id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { unlinkPublication } = await import("@/server/repos/publications");
    await unlinkPublication(data.publication_id);
    return { ok: true };
  });
