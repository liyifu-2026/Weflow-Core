// One-off diagnostic: inspect test DB schema state relevant to integration failures.
import pg from "pg";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgresql://weflow:weflow@127.0.0.1:5432/weflow_test";
const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  const col = await client.query(
    "SELECT column_name, column_default, is_nullable FROM information_schema.columns WHERE table_name='contact_profiles' AND column_name='agent_enabled'",
  );
  console.log("agent_enabled column:", JSON.stringify(col.rows));
  const migrations = await client.query(
    "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3",
  );
  console.log("last migrations:", JSON.stringify(migrations.rows));
  const tables = await client.query(
    "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'",
  );
  console.log("public tables:", tables.rows[0]?.n);
} finally {
  await client.end();
}
