// One-off helper: ensure the weflow_test database exists for integration tests.
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const url = new URL(databaseUrl);
url.pathname = "/postgres";
const client = new pg.Client({ connectionString: url.toString() });
try {
  await client.connect();
  const exists = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = 'weflow_test'",
  );
  if (exists.rowCount === 0) {
    await client.query("CREATE DATABASE weflow_test");
    console.log("created weflow_test");
  } else {
    console.log("weflow_test exists");
  }
} finally {
  await client.end();
}
