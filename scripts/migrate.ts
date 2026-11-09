// Applies db/migrations/*.sql in order, once each. Run with the admin (owner) URL.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

async function main() {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL is required to run migrations");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const dir = join(process.cwd(), "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const { rowCount } = await db.query("select 1 from schema_migrations where name = $1", [file]);
      if (rowCount) continue;
      const sql = readFileSync(join(dir, file), "utf8");
      await db.query("begin");
      try {
        await db.query(sql);
        await db.query("insert into schema_migrations (name) values ($1)", [file]);
        await db.query("commit");
        console.log(`applied ${file}`);
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    }
    console.log("migrations up to date");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
