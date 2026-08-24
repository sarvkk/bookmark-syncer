import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { users } from "@syncer/db";
import { DevRegisterSchema, type DevRegisterResponse } from "@syncer/shared";
import { getDb, randomToken, sha256Hex } from "../auth";
import type { AppEnv } from "../env";

export const authRoutes = new Hono<AppEnv>();

/**
 * DEVELOPMENT AUTHENTICATION.
 *
 * This endpoint exchanges an email for a long-lived bearer token without any
 * verification. It exists so the first milestone can be tested end-to-end.
 * It MUST be removed or gated before any production use; the sync engine and
 * device model deliberately know nothing about this scheme so a managed
 * provider can replace it later.
 *
 * Set DISABLE_DEV_AUTH=1 (Worker secret/var) to turn this endpoint off.
 */
authRoutes.post("/auth/dev/register", async (c) => {
  if (c.env.DISABLE_DEV_AUTH === "1" || c.env.DISABLE_DEV_AUTH?.toLowerCase() === "true") {
    return c.json({ error: "development authentication is disabled" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = DevRegisterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body" }, 400);
  }

  const db = getDb(c);
  const email = parsed.data.email.toLowerCase();
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing[0]) {
    // Dev convenience only: re-issue a token instead of failing.
    const token = randomToken();
    await db
      .update(users)
      .set({ authTokenHash: await sha256Hex(token) })
      .where(eq(users.id, existing[0].id));
    const response: DevRegisterResponse = { userId: existing[0].id, userToken: token };
    return c.json(response);
  }

  const token = randomToken();
  const inserted = await db
    .insert(users)
    .values({ email, authTokenHash: await sha256Hex(token) })
    .returning({ id: users.id });

  const response: DevRegisterResponse = { userId: inserted[0]!.id, userToken: token };
  return c.json(response, 201);
});
