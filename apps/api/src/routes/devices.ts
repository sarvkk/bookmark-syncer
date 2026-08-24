import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { devices } from "@syncer/db";
import {
  DeviceRegistrationSchema,
  type DeviceCredentials,
  type DeviceInfo,
} from "@syncer/shared";
import { getDb, randomToken, requireUser, sha256Hex } from "../auth";
import type { AppEnv } from "../env";

export const deviceRoutes = new Hono<AppEnv>();

deviceRoutes.use("/devices", requireUser);
deviceRoutes.use("/devices/*", requireUser);

function toDeviceInfo(row: { id: string; name: string; platform: string; createdAt: Date; lastSeenAt: Date | null }): DeviceInfo {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.getTime() : null,
  };
}

deviceRoutes.post("/devices", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = DeviceRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body" }, 400);
  }

  const db = getDb(c);
  const userId = c.get("userId");
  const token = randomToken();
  const inserted = await db
    .insert(devices)
    .values({
      userId,
      name: parsed.data.name,
      platform: parsed.data.platform,
      tokenHash: await sha256Hex(token),
    })
    .returning({ id: devices.id });

  const credentials: DeviceCredentials = {
    deviceId: inserted[0]!.id,
    deviceToken: token,
  };
  return c.json(credentials, 201);
});

deviceRoutes.get("/devices", async (c) => {
  const db = getDb(c);
  const rows = await db
    .select({
      id: devices.id,
      name: devices.name,
      platform: devices.platform,
      createdAt: devices.createdAt,
      lastSeenAt: devices.lastSeenAt,
    })
    .from(devices)
    .where(eq(devices.userId, c.get("userId")));
  return c.json(rows.map(toDeviceInfo));
});

deviceRoutes.delete("/devices/:id", async (c) => {
  const db = getDb(c);
  const deleted = await db
    .delete(devices)
    .where(and(eq(devices.id, c.req.param("id")), eq(devices.userId, c.get("userId"))))
    .returning({ id: devices.id });
  if (deleted.length === 0) {
    return c.json({ error: "not found" }, 404);
  }
  return c.body(null, 204);
});
