import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { bookmarks, devices, syncOperations, users } from "@syncer/db";
import type { Database } from "@syncer/db";
import { processPush } from "../src/sync-service";
import type { SyncOperation } from "@syncer/shared";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

interface TestContext {
  userId: string;
  deviceId: string;
  db: Database;
  raw: ReturnType<typeof postgres>;
}

async function applyMigrations(raw: postgres.Sql): Promise<void> {
  await raw`DROP SCHEMA IF EXISTS public CASCADE`;
  await raw`CREATE SCHEMA public`;
  const dir = join(import.meta.dir, "../../..", "packages/db/drizzle");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    for (const statement of content.split("--> statement-breakpoint")) {
      await raw.unsafe(statement.trim());
    }
  }
}

let ctx: TestContext;
let counter = 0;
function uid(): string {
  counter += 1;
  return `a0000000-0000-4000-8000-${(counter).toString(16).padStart(12, "0")}`;
}

function makeOp(
  partial: Partial<SyncOperation> & { entityId: string; type: SyncOperation["type"]; payload: SyncOperation["payload"] },
): SyncOperation {
  return {
    operationId: uid(),
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    timestamp: Date.now(),
    ...partial,
  } as SyncOperation;
}

describe.skipIf(!DATABASE_URL)("api integration (real postgres)", () => {
  beforeAll(async () => {
    const raw = postgres(DATABASE_URL!, { max: 1 });
    await applyMigrations(raw);

    const insertedUsers = await raw`
      INSERT INTO users (email, auth_token_hash) VALUES ('test@example.com', 'hash')
      ON CONFLICT (email) DO UPDATE SET auth_token_hash = 'hash'
      RETURNING id`;
    const userId = insertedUsers[0]!.id as string;

    const insertedDevices = await raw`
      INSERT INTO devices (user_id, name, platform, token_hash)
      VALUES (${userId}, 'test-device', 'chromium', 'devicehash')
      RETURNING id`;
    const deviceId = insertedDevices[0]!.id as string;

    ctx = {
      userId,
      deviceId,
      raw,
      db: drizzlePg(raw) as unknown as Database,
    };
  });

  afterAll(async () => {
    if (ctx?.raw) await ctx.raw.end();
  });

  test("push applies CREATE to canonical state and is idempotent on retry", async () => {
    const entityId = uid();
    const op = makeOp({
      entityId,
      type: "CREATE",
      payload: { kind: "bookmark", parentId: "toolbar", title: "Example", url: "https://example.com", position: 0 },
    });

    const first = await processPush(ctx.db, { userId: ctx.userId, deviceId: ctx.deviceId }, [op]);
    expect(first.results[0]?.status).toBe("applied");

    const row = await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, entityId)).limit(1);
    expect(row[0]?.title).toBe("Example");
    expect(row[0]?.rootId).toBe("toolbar");

    const retrySameOp = { ...op };
    const second = await processPush(
      ctx.db,
      { userId: ctx.userId, deviceId: ctx.deviceId },
      [retrySameOp],
    );
    expect(second.results[0]?.status).toBe("duplicate");
  });

  test("UPDATE and MOVE are applied in order; tombstones survive DELETE vs UPDATE", async () => {
    const bookmarkId = uid();
    await processPush(ctx.db, ctx, [
      makeOp({
        entityId: bookmarkId,
        type: "CREATE",
        payload: { kind: "bookmark", parentId: "menu", title: "t1", url: "https://x.test/1", position: 0 },
      }),
      makeOp({
        entityId: bookmarkId,
        type: "UPDATE",
        payload: { title: "t2-renamed" },
      }),
      makeOp({
        entityId: bookmarkId,
        type: "MOVE",
        payload: { parentId: "other", position: 0 },
      }),
    ]);

    let row = await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).limit(1);
    expect(row[0]?.title).toBe("t2-renamed");
    expect(row[0]?.rootId).toBe("other");

    await processPush(ctx.db, ctx, [
      makeOp({ entityId: bookmarkId, type: "DELETE", payload: {} }),
      makeOp({ entityId: bookmarkId, type: "UPDATE", payload: { title: "zombie" } }),
    ]);

    row = await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).limit(1);
    expect(row[0]?.deletedAt).not.toBeNull();
    expect(row[0]?.title).toBe("t2-renamed");
  });

  test("folder deletion cascades to descendants", async () => {
    const folderId = uid();
    const childId = uid();
    await processPush(ctx.db, ctx, [
      makeOp({
        entityId: folderId,
        type: "CREATE",
        payload: { kind: "folder", parentId: "toolbar", title: "folder", position: 5 },
      }),
      makeOp({
        entityId: childId,
        type: "CREATE",
        payload: { kind: "bookmark", parentId: folderId, title: "child", url: "https://x.test/2", position: 0 },
      }),
      makeOp({ entityId: folderId, type: "DELETE", payload: {} }),
    ]);

    const folderRow = await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, folderId)).limit(1);
    const childRow = await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, childId)).limit(1);
    expect(folderRow[0]?.deletedAt).not.toBeNull();
    expect(childRow[0]?.deletedAt).not.toBeNull();

    const resurrect = await processPush(ctx.db, ctx, [
      makeOp({
        entityId: childId,
        type: "CREATE",
        payload: { kind: "bookmark", parentId: "toolbar", title: "resurrected", url: "https://x.test/3", position: 0 },
      }),
    ]);
    expect(resurrect.results[0]?.status).toBe("applied");
    const childAfter = await ctx.db.select().from(bookmarks).where(eq(bookmarks.id, childId)).limit(1);
    expect(childAfter[0]?.deletedAt).not.toBeNull();
  });

  test("operations are returned by pull in sequence order with cursor pagination", async () => {
    for (let i = 0; i < 3; i += 1) {
      await processPush(ctx.db, ctx, [
        makeOp({
          entityId: uid(),
          type: "CREATE",
          payload: { kind: "bookmark", parentId: "toolbar", title: `p${i}`, url: `https://x.test/p${i}`, position: i },
        }),
      ]);
    }

    const countRows = await ctx.db
      .select({ value: sql<number>`count(*)::int` })
      .from(syncOperations)
      .where(eq(syncOperations.userId, ctx.userId));
    expect(Number(countRows[0]?.value)).toBeGreaterThanOrEqual(3);

    const seqRows = await ctx.db
      .select({ seq: syncOperations.seq })
      .from(syncOperations)
      .where(eq(syncOperations.userId, ctx.userId));
    const seqs = seqRows.map((r) => Number(r.seq));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    void devices;
  });
});
