/**
 * One-time Phase 2 historical media state convergence.
 *
 * This script is intentionally explicit: the operator must confirm that a
 * PostgreSQL dump and the media directory backup already exist. It updates
 * only legacy queued/downloading rows that have a sourceLocalId but no
 * stored file. It never deletes a media row, file, or migration journal tag.
 */
import { and, inArray, isNull, isNotNull } from "drizzle-orm";
import { createLogger } from "../infrastructure/observability/logger.js";
import { createPostgres } from "../infrastructure/postgres/client.js";
import * as schema from "../infrastructure/postgres/schema.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const backupConfirmed = process.env.WEFLOW_MEDIA_BACKUP_CONFIRMED === "1";
const backupReference = process.env.WEFLOW_MEDIA_BACKUP_REFERENCE?.trim();

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!backupConfirmed || !backupReference) {
  throw new Error(
    "Refusing historical media convergence: set WEFLOW_MEDIA_BACKUP_CONFIRMED=1 and WEFLOW_MEDIA_BACKUP_REFERENCE to the verified database/media backup",
  );
}

const postgres = createPostgres(
  databaseUrl,
  createLogger({ logLevel: "silent" }, "converge-legacy-media"),
);

try {
  const candidates = await postgres.db
    .select({ mediaId: schema.mediaAssets.mediaId })
    .from(schema.mediaAssets)
    .where(
      and(
        inArray(schema.mediaAssets.status, ["queued", "downloading"]),
        isNotNull(schema.mediaAssets.sourceLocalId),
        isNull(schema.mediaAssets.originalFileId),
        isNull(schema.mediaAssets.originalImageFileId),
      ),
    );

  const updated = await postgres.db
    .update(schema.mediaAssets)
    .set({
      status: "failed",
      errorCode: "legacy_channel_unsupported",
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(schema.mediaAssets.status, ["queued", "downloading"]),
        isNotNull(schema.mediaAssets.sourceLocalId),
        isNull(schema.mediaAssets.originalFileId),
        isNull(schema.mediaAssets.originalImageFileId),
      ),
    )
    .returning({ mediaId: schema.mediaAssets.mediaId });

  process.stdout.write(
    JSON.stringify(
      {
        backupReference,
        matchedCount: candidates.length,
        updatedCount: updated.length,
        preservedRecords: true,
        preservedFiles: true,
        migrationJournalChanged: false,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await postgres.close();
}
