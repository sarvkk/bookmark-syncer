import { Hono } from "hono";
import { and, asc, eq, isNull } from "drizzle-orm";
import { bookmarks } from "@syncer/db";
import {
  ROOT_IDS,
  type BookmarkTreeResponse,
  type BookmarkTreeNodeDto,
} from "@syncer/shared";
import { getDb, requireUser } from "../auth";
import type { AppEnv } from "../env";

export const bookmarkRoutes = new Hono<AppEnv>();

bookmarkRoutes.use("/bookmarks/*", requireUser);

/**
 * Returns the resolved canonical tree for the user. Used for bootstrap and
 * the dashboard; the sync protocol itself is operation-based.
 */
bookmarkRoutes.get("/bookmarks/tree", async (c) => {
  const userId = c.get("userId");
  const db = getDb(c);

  const rows = await db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), isNull(bookmarks.deletedAt)))
    .orderBy(asc(bookmarks.position));

  const dtos = new Map<string, BookmarkTreeNodeDto>();
  for (const row of rows) {
    dtos.set(row.id, {
      id: row.id,
      kind: row.kind,
      title: row.title,
      url: row.url,
      position: Number(row.position),
      children: [],
    });
  }

  const childrenOf = new Map<string, BookmarkTreeNodeDto[]>();
  for (const row of rows) {
    const parentKey = row.rootId !== null ? row.rootId : row.parentId;
    if (!parentKey) continue;
    const dto = dtos.get(row.id);
    if (!dto) continue;
    const list = childrenOf.get(parentKey) ?? [];
    list.push(dto);
    childrenOf.set(parentKey, list);
  }

  function buildRoot(rootId: string): BookmarkTreeNodeDto {
    return {
      id: rootId,
      kind: "root",
      title: rootId,
      url: null,
      position: 0,
      children: [...(childrenOf.get(rootId) ?? [])].sort((a, b) => a.position - b.position),
    };
  }

  for (const [parentKey, list] of childrenOf) {
    if (!ROOT_IDS.includes(parentKey as never)) {
      list.sort((a, b) => a.position - b.position);
    }
  }

  const response: BookmarkTreeResponse = { roots: ROOT_IDS.map(buildRoot) };
  return c.json(response);
});
