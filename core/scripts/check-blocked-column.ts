/**
 * 检查 conversation.contact_profiles 是否已有 blocked 列（黑名单迁移 0063）。
 * 用法：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/check-blocked-column.ts
 */
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const r = await client.query(
  "SELECT column_name FROM information_schema.columns WHERE table_schema='conversation' AND table_name='contact_profiles' ORDER BY ordinal_position",
);
console.log(r.rows.map((x) => x.column_name).join(", "));
const hasBlocked = r.rows.some((x) => x.column_name === "blocked");
console.log(`blocked column present: ${hasBlocked}`);
const applied = await client.query(
  "SELECT name FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3",
);
console.log("last migrations:", applied.rows.map((x) => x.name).join(" | "));
await client.end();
