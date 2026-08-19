DROP SCHEMA IF EXISTS "knowledge" CASCADE;

DELETE FROM "file_storage"."files"
WHERE "owner_module" = 'knowledge';
