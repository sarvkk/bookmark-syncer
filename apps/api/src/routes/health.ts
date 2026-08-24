import { Hono } from "hono";
import type { AppEnv } from "../env";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", (c) =>
  c.json({ ok: true, service: "bookmark-sync-api", time: Date.now() }),
);
