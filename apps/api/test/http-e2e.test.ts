import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import app from "../src/index";
import type { AppEnv } from "../src/env";

const DATABASE_URL = process.env.TEST_DATABASE_URL;

let raw: ReturnType<typeof postgres>;
const bindings = { DATABASE_URL: DATABASE_URL ?? "" };

function fetchApp(path: string, init: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost:8787${path}`, init), bindings);
}

interface Session {
  userId: string;
  userToken: string;
}

interface Device {
  deviceId: string;
  deviceToken: string;
}

async function registerUser(email: string): Promise<Session> {
  const response = await fetchApp("/auth/dev/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Session;
}

async function registerDevice(session: Session, name: string): Promise<Device> {
  const response = await fetchApp("/devices", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.userToken}`,
      "x-user-id": session.userId,
    },
    body: JSON.stringify({ name, platform: "chromium" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Device;
}

function deviceHeaders(session: Session, device: Device): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${device.deviceToken}`,
    "x-user-id": session.userId,
    "x-device-id": device.deviceId,
  };
}

function op(partial: Record<string, unknown>): unknown {
  return {
    operationId: crypto.randomUUID(),
    timestamp: Date.now(),
    ...partial,
  };
}

describe.skipIf(!DATABASE_URL)("api http e2e", () => {
  beforeAll(async () => {
    raw = postgres(DATABASE_URL!, { max: 1 });
    await raw`DROP SCHEMA IF EXISTS public CASCADE`;
    await raw`CREATE SCHEMA public`;
    const dir = join(import.meta.dir, "../../..", "packages/db/drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      for (const statement of readFileSync(join(dir, file), "utf8").split("--> statement-breakpoint")) {
        await raw.unsafe(statement.trim());
      }
    }
  });

  afterAll(async () => {
    if (raw) await raw.end();
  });

  test("two devices synchronize create/update/move/delete through the protocol", async () => {
    const session = await registerUser(`e2e-${Date.now()}@example.com`);
    const browser1 = await registerDevice(session, "browser-1");
    const browser2 = await registerDevice(session, "browser-2");

    // --- device 1 creates folder + bookmark, renames bookmark ---
    const folderId = crypto.randomUUID();
    const bmId = crypto.randomUUID();
    const ts = Date.now();

    const push1 = await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(session, browser1),
      body: JSON.stringify({
        operations: [
          op({ userId: session.userId, deviceId: browser1.deviceId, entityId: folderId, type: "CREATE",
            payload: { kind: "folder", parentId: "toolbar", title: "Work", position: 0 } }),
          op({ userId: session.userId, deviceId: browser1.deviceId, entityId: bmId, type: "CREATE",
            payload: { kind: "bookmark", parentId: folderId, title: "Docs", url: "https://docs.example.com", position: 0 } }),
          op({ userId: session.userId, deviceId: browser1.deviceId, entityId: bmId, type: "UPDATE",
            payload: { title: "Documentation" } }),
        ],
      }),
    });
    expect(push1.status).toBe(200);
    const push1Body = (await push1.json()) as { results: Array<{ status: string }> };
    expect(push1Body.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);

    // --- idempotent retry of the same operation ---
    const firstPull = await fetchApp("/sync/pull?cursor=0&limit=1", {
      headers: deviceHeaders(session, browser2),
    });
    const firstPullBody = (await firstPull.json()) as { operations: Array<{ operationId: string }> };
    const firstOpId = firstPullBody.operations[0]!.operationId;
    const retry = await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(session, browser1),
      body: JSON.stringify({
        operations: [{
          operationId: firstOpId,
          userId: session.userId,
          deviceId: browser1.deviceId,
          entityId: folderId,
          type: "CREATE",
          payload: { kind: "folder", parentId: "toolbar", title: "Work", position: 0 },
          timestamp: ts,
        }],
      }),
    });
    expect(((await retry.json()) as { results: Array<{ status: string }> }).results[0]?.status).toBe("duplicate");

    // --- device 2 pulls and sees both operations in order ---
    const pull = await fetchApp("/sync/pull?cursor=0&limit=100", {
      headers: deviceHeaders(session, browser2),
    });
    const pullBody = (await pull.json()) as {
      operations: Array<{ type: string; payload: Record<string, unknown> }>;
      cursor: number;
      hasMore: boolean;
    };
    expect(pullBody.operations.map((o) => o.type)).toEqual(["CREATE", "CREATE", "UPDATE"]);
    expect(pullBody.hasMore).toBe(false);

    // --- device 2 moves the bookmark out of the folder; device 1 sees it ---
    await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(session, browser2),
      body: JSON.stringify({
        operations: [op({ userId: session.userId, deviceId: browser2.deviceId, entityId: bmId, type: "MOVE",
          payload: { parentId: "menu", position: 0 } })],
      }),
    });

    const pull2 = await fetchApp(`/sync/pull?cursor=${pullBody.cursor}&limit=100`, {
      headers: deviceHeaders(session, browser1),
    });
    const pull2Body = (await pull2.json()) as { operations: Array<{ type: string; entityId: string }> };
    expect(pull2Body.operations.map((o) => o.type)).toEqual(["MOVE"]);
    expect(pull2Body.operations[0]?.entityId).toBe(bmId);

    // --- delete the folder; cascade must not resurrect via later UPDATE ---
    await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(session, browser2),
      body: JSON.stringify({
        operations: [
          op({ userId: session.userId, deviceId: browser2.deviceId, entityId: folderId, type: "DELETE", payload: {} }),
          op({ userId: session.userId, deviceId: browser2.deviceId, entityId: folderId, type: "UPDATE",
            payload: { title: "zombie" } }),
        ],
      }),
    });

    const treeResponse = await fetchApp("/bookmarks/tree", {
      headers: { authorization: `Bearer ${session.userToken}` },
    });
    const tree = (await treeResponse.json()) as {
      roots: Array<{ id: string; children: Array<{ id: string; title: string }> }>;
    };
    const toolbar = tree.roots.find((r) => r.id === "toolbar");
    expect(toolbar?.children.some((c) => c.id === folderId && c.title === "Work")).toBe(false);
    const menu = tree.roots.find((r) => r.id === "menu");
    expect(menu?.children.some((c) => c.id === bmId && c.title === "Documentation")).toBe(true);
  });

  test("rejects cross-identity operations and foreign entities", async () => {
    const owner = await registerUser(`owner-${Date.now()}@example.com`);
    const attacker = await registerUser(`attacker-${Date.now()}@example.com`);
    const ownerDevice = await registerDevice(owner, "owner-device");
    const attackerDevice = await registerDevice(attacker, "attacker-device");

    // attacker claims to be the owner's device
    const badIdentity = await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(attacker, attackerDevice),
      body: JSON.stringify({
        operations: [op({ userId: owner.userId, deviceId: ownerDevice.deviceId, entityId: crypto.randomUUID(),
          type: "DELETE", payload: {} })],
      }),
    });
    expect(((await badIdentity.json()) as { results: Array<{ reason?: string }> }).results[0]?.reason)
      .toBe("identity-mismatch");

    // valid identity but foreign entity id
    const entityId = crypto.randomUUID();
    await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(owner, ownerDevice),
      body: JSON.stringify({
        operations: [op({ userId: owner.userId, deviceId: ownerDevice.deviceId, entityId, type: "CREATE",
          payload: { kind: "bookmark", parentId: "other", title: "secret", url: "https://x.example.com", position: 0 } })],
      }),
    });
    const steal = await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(attacker, attackerDevice),
      body: JSON.stringify({
        operations: [op({ userId: attacker.userId, deviceId: attackerDevice.deviceId, entityId, type: "UPDATE",
          payload: { title: "hacked" } })],
      }),
    });
    expect(((await steal.json()) as { results: Array<{ reason?: string }> }).results[0]?.reason)
      .toBe("entity-owned-by-other");
  });

  test("device token from another account is rejected", async () => {
    const a = await registerUser(`tok-a-${Date.now()}@example.com`);
    const b = await registerDevice(await registerUser(`tok-b-${Date.now()}@example.com`), "b-device");

    const response = await fetchApp("/devices", {
      headers: {
        authorization: `Bearer ${b.deviceToken}`,
        "x-user-id": a.userId,
      },
    });
    expect(response.status).toBe(401);
  });

  test("malformed operations are rejected with 400", async () => {
    const session = await registerUser(`bad-${Date.now()}@example.com`);
    const device = await registerDevice(session, "d");
    const response = await fetchApp("/sync/push", {
      method: "POST",
      headers: deviceHeaders(session, device),
      body: JSON.stringify({
        operations: [op({ userId: session.userId, deviceId: device.deviceId, entityId: crypto.randomUUID(),
          type: "CREATE", payload: { kind: "bookmark", parentId: "toolbar", title: "no url", position: 0 } })],
      }),
    });
    expect(response.status).toBe(400);
  });

  test("operations log is strictly ordered per user", async () => {
    const rows = await raw`
      SELECT user_id, seq FROM sync_operations ORDER BY user_id, seq`;
    let lastUser = "";
    let lastSeq = 0;
    let monotonic = true;
    for (const row of rows as Array<{ user_id: string; seq: number | string }>) {
      const seq = Number(row.seq);
      if (row.user_id !== lastUser) {
        lastUser = row.user_id;
        lastSeq = 0;
      }
      if (seq <= lastSeq) monotonic = false;
      lastSeq = seq;
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(monotonic).toBe(true);
  });
});
