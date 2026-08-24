import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppEnv } from "./env";
import { rateLimit } from "./rate-limit";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { deviceRoutes } from "./routes/devices";
import { syncRoutes } from "./routes/sync";
import { bookmarkRoutes } from "./routes/bookmarks";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.use(
  "*",
  cors({
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["x-user-id", "x-device-id"],
  }),
);
app.use("/auth/*", rateLimit({ windowMs: 60_000, max: 10, keyBy: "auth" }));
app.use("/sync/*", rateLimit({ windowMs: 60_000, max: 120, keyBy: "sync" }));

app.route("/", healthRoutes);
app.route("/", authRoutes);
app.route("/", deviceRoutes);
app.route("/", syncRoutes);
app.route("/", bookmarkRoutes);

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  console.error("unhandled error:", err);
  const message = err instanceof Error ? err.message : String(err);
  const dbUnavailable =
    message.includes("relation") && message.includes("does not exist") ||
    message.includes("ECONNREFUSED") ||
    message.includes("too many clients");
  if (dbUnavailable) {
    return c.json({ error: "database unavailable" }, 503);
  }
  return c.json({ error: "internal server error" }, 500);
});

export default app;
