// 단순 SQL 마이그레이션 러너: db/migrations/*.sql 을 버전 순서로 1회 적용 (docs/05 §6)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export async function runMigrations(databaseUrl: string, dir = join(process.cwd(), "db", "migrations")): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const applied: string[] = [];
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await pool.query("SELECT pg_advisory_lock(727272)");
    try {
      const done = new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files) {
        if (done.has(f)) continue;
        const sql = readFileSync(join(dir, f), "utf8");
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [f]);
          await client.query("COMMIT");
          applied.push(f);
        } catch (e) {
          await client.query("ROLLBACK");
          throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          client.release();
        }
      }
    } finally {
      await pool.query("SELECT pg_advisory_unlock(727272)");
    }
  } finally {
    await pool.end();
  }
  return applied;
}

// CLI: pnpm db:migrate
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  import("dotenv")
    .then(({ config }) => {
      config();
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL 이 필요합니다");
      return runMigrations(url);
    })
    .then((a) => {
      console.log(a.length ? `applied: ${a.join(", ")}` : "no pending migrations");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
