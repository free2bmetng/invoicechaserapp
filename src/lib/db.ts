// Two pools. Request code uses withUser(), which runs every query as the
// RLS-enforced app_rls role with app.user_id set for the transaction.
// Cron and webhook code uses withService(), which bypasses RLS, so every query
// in it must filter by user_id explicitly.
import { Pool, PoolClient } from "pg";

let requestPool: Pool | undefined;
let servicePool: Pool | undefined;

function requestDb(): Pool {
  if (!requestPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    requestPool = new Pool({ connectionString: url, max: 10 });
  }
  return requestPool;
}

function serviceDb(): Pool {
  if (!servicePool) {
    const url = process.env.DATABASE_SERVICE_URL;
    if (!url) throw new Error("DATABASE_SERVICE_URL is not set");
    servicePool = new Pool({ connectionString: url, max: 5 });
  }
  return servicePool;
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function withUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(requestDb(), async (c) => {
    await c.query("select set_config('app.user_id', $1, true)", [userId]);
    return fn(c);
  });
}

export function withService<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(serviceDb(), fn);
}

export async function closeDb(): Promise<void> {
  await Promise.all([requestPool?.end(), servicePool?.end()]);
  requestPool = undefined;
  servicePool = undefined;
}
