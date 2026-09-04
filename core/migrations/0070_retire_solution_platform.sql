-- 0070: 平台化系统拆除（R3）。
-- 删除 solution schema 中服务「多方案平台」的全部表；仅保留
-- extension_settings 作为设置中心的通用 JSON 设置存储。
-- 主键从 (solution_id, extension_id) 收敛为 (scope, key)，
-- 既有数据通过表重建完整迁移。

ALTER TABLE "solution"."extension_settings" DROP CONSTRAINT "extension_settings_solution_id_installations_solution_id_fk";

DROP TABLE "solution"."secret_assignments";
DROP TABLE "solution"."events";
DROP TABLE "solution"."resource_ownership";
DROP TABLE "solution"."operation_payloads";
DROP TABLE "solution"."operations";
DROP TABLE "solution"."versions";
DROP TABLE "solution"."installations";

CREATE TABLE "solution"."extension_settings_new" (
  "scope" varchar(200) NOT NULL,
  "key" varchar(200) NOT NULL,
  "settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_by" varchar(200),
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("scope", "key")
);

INSERT INTO "solution"."extension_settings_new" ("scope", "key", "settings_json", "updated_by", "updated_at")
SELECT "solution_id", "extension_id", "settings_json", "updated_by", "updated_at" FROM "solution"."extension_settings";

DROP TABLE "solution"."extension_settings";
ALTER TABLE "solution"."extension_settings_new" RENAME TO "extension_settings";
