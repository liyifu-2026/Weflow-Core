// One-off helper: apply Drizzle migrations to the integration-test database.
// Mirrors infrastructure/postgres/migrate.ts but takes the URL from
// TEST_DATABASE_URL (falling back to DATABASE_URL) without requiring full
// platform config.
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres } from "../infrastructure/postgres/client.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("TEST_DATABASE_URL or DATABASE_URL not set");
  process.exit(1);
}
const logger = createLogger(
  { logLevel: "silent" },
  "test-db-migration",
);
const postgres = createPostgres(databaseUrl, logger);
try {
  await migrate(postgres.db, { migrationsFolder: resolve("migrations") });
  console.log("test database migrations completed");
} finally {
  await postgres.close();
}
