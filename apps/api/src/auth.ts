import type { Context, MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { createDb, devices, users, type Database } from "@syncer/db";
import type { AppEnv } from "./env";

const dbClients = new Map<string, Database>();

/**
 * One client per unique DATABASE_URL, reused across requests for the
 * lifetime of the isolate. Creating a pool per request leaks TCP
 * connections until Postgres refuses them.
 */
export function getDb(c: Context<AppEnv>): Database {
  const url = c.env.DATABASE_URL;
  let db = dbClients.get(url);
  if (!db) {
    db = createDb(url);
    dbClients.set(url, db);
  }
  return db;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : null;
}

/**
 * Resolves a user from a bearer token (users.auth_token_hash).
 * Development-grade authentication; see docs/architecture.md before
 * replacing it with a managed provider.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c);
  if (!token) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const db = getDb(c);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authTokenHash, await sha256Hex(token)))
    .limit(1);
  const user = rows[0];
  if (!user) {
    return c.json({ error: "invalid token" }, 401);
  }
  c.set("userId", user.id);
  await next();
};

/**
 * Resolves the calling device from x-user-id / x-device-id headers plus a
 * device bearer token. Rejects tokens that do not belong to the claimed
 * user/device pair.
 */
export const requireDevice: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearerToken(c);
  const userId = c.req.header("x-user-id");
  const deviceId = c.req.header("x-device-id");
  if (!token || !userId || !deviceId) {
    return c.json({ error: "missing device credentials" }, 401);
  }
  const db = getDb(c);
  const rows = await db
    .select({
      id: devices.id,
      userId: devices.userId,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(eq(devices.tokenHash, await sha256Hex(token)))
    .limit(1);
  const device = rows[0];
  if (!device || device.id !== deviceId || device.userId !== userId) {
    return c.json({ error: "unauthorized device" }, 401);
  }
  c.set("userId", device.userId);
  c.set("deviceId", device.id);

  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, device.id));

  await next();
};
