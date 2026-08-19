ALTER TABLE "identity"."users" ADD COLUMN "avatar_file_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "identity"."users" ADD CONSTRAINT "users_avatar_file_id_files_file_id_fk" FOREIGN KEY ("avatar_file_id") REFERENCES "file_storage"."files"("file_id") ON DELETE set null ON UPDATE no action;
