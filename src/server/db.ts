import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "./config";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let db: Db | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getConfig().DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("[db] pool error:", e.message));
  }
  return pool;
}

export function getDb(): Db {
  if (!db) db = drizzle(getPool(), { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { schema };
