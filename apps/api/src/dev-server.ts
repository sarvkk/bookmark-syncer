import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import app from "./index";

function loadDotDevVars(): Record<string, string> {
  const path = join(import.meta.dir, "../.dev.vars");
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const dotEnv = loadDotDevVars();
if (!process.env.DATABASE_URL && dotEnv.DATABASE_URL) {
  process.env.DATABASE_URL = dotEnv.DATABASE_URL;
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set (env or apps/api/.dev.vars)");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);

// Fail fast with an actionable message when the schema is missing (e.g.
// database recreated without re-running migrations).
try {
  const { createDb } = await import("@syncer/db");
  const { devices } = await import("@syncer/db");
  await createDb(process.env.DATABASE_URL!).select().from(devices).limit(1);
} catch {
  console.error(
    "\nDatabase schema looks missing or unreachable. Run:\n" +
      "  export DATABASE_URL=... && bun run --cwd packages/db migrate\n",
  );
}

// Mirror how Cloudflare Workers injects bindings into the fetch handler.
const bindings = {
  DATABASE_URL: process.env.DATABASE_URL!,
  ...(dotEnv.DISABLE_DEV_AUTH ? { DISABLE_DEV_AUTH: dotEnv.DISABLE_DEV_AUTH } : {}),
  ...(process.env.DISABLE_DEV_AUTH ? { DISABLE_DEV_AUTH: process.env.DISABLE_DEV_AUTH } : {}),
};

const server = Bun.serve({
  port,
  fetch: (request) => app.fetch(request, bindings),
});

console.log(`bookmark-sync API (local dev server) → http://localhost:${server.port}`);
