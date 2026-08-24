import { neon } from "@neondatabase/serverless";
import { drizzle as httpDrizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as tcpDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = NeonHttpDatabase<typeof schema>;

/**
 * Creates a database client.
 *
 * - Neon URLs use the neon-http driver (required on Cloudflare Workers).
 * - Any other PostgreSQL URL (local development, self-hosting, tests) uses
 *   postgres-js over TCP. The returned instances are query-compatible for
 *   everything this project does, hence the shared `Database` type.
 */
export function createDb(url: string): Database {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`invalid DATABASE_URL: ${url.replace(/:[^:@]*@/, ":***@")}`);
  }

  if (/\.neon\.(tech|build)$/.test(host)) {
    return httpDrizzle(neon(url), { schema });
  }

  return tcpDrizzle(postgres(url, { max: 5 })) as unknown as Database;
}

export * from "./schema";
