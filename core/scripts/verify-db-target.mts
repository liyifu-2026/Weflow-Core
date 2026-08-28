import { loadConfig } from "../infrastructure/config/config.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import { createLogger } from "../infrastructure/observability/logger.js";

const config = loadConfig();
console.log("DATABASE_URL 指向:", config.databaseUrl.replace(/:[^:@]+@/, ":***@"));
const pg = createPostgres(config.databaseUrl, createLogger({ logLevel: "silent" }, "verify"));
const r = await pg.db.execute(`select count(*)::int as n from information_schema.tables where table_schema='public'`);
const rows = (r as unknown as { rows: Array<{ n: number }> }).rows ?? [];
console.log("public 表数量:", rows[0]?.n);
await pg.close();
