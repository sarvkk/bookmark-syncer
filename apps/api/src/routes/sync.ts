import { Hono } from "hono";
import { and, asc, eq, gt } from "drizzle-orm";
import { syncCursors, syncOperations } from "@syncer/db";
import {
  PullQuerySchema,
  PushRequestSchema,
  SyncOperationSchema,
  type PullResponse,
  type PushResponse,
  type SyncOperation,
} from "@syncer/shared";
import { requireDevice, getDb } from "../auth";
import type { AppEnv } from "../env";
import { processPush } from "../sync-service";

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.use("/sync/*", requireDevice);

syncRoutes.post("/sync/push", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = PushRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid operations", details: parsed.error.flatten() }, 400);
  }

  const outcome = await processPush(getDb(c), {
    userId: c.get("userId"),
    deviceId: c.get("deviceId"),
  }, parsed.data.operations);

  const response: PushResponse = {
    results: outcome.results,
    serverCursor: outcome.serverCursor,
  };
  return c.json(response);
});

syncRoutes.get("/sync/pull", async (c) => {
  const parsed = PullQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid query" }, 400);
  }
  const { cursor, limit } = parsed.data;
  const userId = c.get("userId");
  const deviceId = c.get("deviceId");
  const db = getDb(c);

  const rows = await db
    .select()
    .from(syncOperations)
    .where(and(eq(syncOperations.userId, userId), gt(syncOperations.seq, cursor)))
    .orderBy(asc(syncOperations.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const operations: SyncOperation[] = [];
  for (const row of page) {
    const candidate = {
      operationId: row.operationId,
      userId: row.userId,
      deviceId: row.deviceId,
      entityId: row.entityId,
      type: row.type as SyncOperation["type"],
      payload: row.payload,
      timestamp: Number(row.clientTimestamp),
    };
    const validated = SyncOperationSchema.safeParse(candidate);
    if (validated.success) {
      operations.push(validated.data);
    }
  }

  const nextCursor = page.length > 0 ? Number(page[page.length - 1]!.seq) : cursor;

  await db
    .insert(syncCursors)
    .values({ deviceId, lastSeq: nextCursor, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncCursors.deviceId,
      set: { lastSeq: nextCursor, updatedAt: new Date() },
    });

  const response: PullResponse = {
    operations,
    cursor: nextCursor,
    hasMore,
  };
  return c.json(response);
});
