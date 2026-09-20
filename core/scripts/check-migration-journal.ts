/**
 * 迁移一致性检查：磁盘上的 SQL 文件与 drizzle journal 必须一一对应。
 *
 * 0075 曾出现「文件在盘、journal 未登记」的漂移——文件从未被任何数据库
 * 应用，CHECK 约束在全新库上静默缺失。本检查让这类漂移在 CI 即失败。
 * 用法：node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/check-migration-journal.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const migrationsDir = join(import.meta.dirname, "..", "migrations");
const sqlTags = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => name.replace(/\.sql$/, ""))
  .sort();

const journal = JSON.parse(
  readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
) as { entries?: { tag: string }[] };
const journalTags = (journal.entries ?? []).map((entry) => entry.tag).sort();

const onDiskOnly = sqlTags.filter((tag) => !journalTags.includes(tag));
const inJournalOnly = journalTags.filter((tag) => !sqlTags.includes(tag));

if (onDiskOnly.length > 0 || inJournalOnly.length > 0) {
  console.error("migration journal drift detected:");
  if (onDiskOnly.length > 0)
    console.error("  files without journal entry:", onDiskOnly.join(", "));
  if (inJournalOnly.length > 0)
    console.error("  journal entries without file:", inJournalOnly.join(", "));
  process.exit(1);
}
console.log(
  `migration journal consistent: ${String(sqlTags.length)} migrations 1:1 with journal`,
);
