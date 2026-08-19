-- 媒体资产原图文件引用：全尺寸高清图（人工查看 / 视觉描述用）
-- 下载成功才回填；未下载成功时为空，前端据此隐藏"查看原图"
ALTER TABLE "media"."assets" ADD COLUMN "original_image_file_id" varchar(36);
--> statement-breakpoint
ALTER TABLE "media"."assets" ADD CONSTRAINT "assets_original_image_file_id_files_file_id_fk" FOREIGN KEY ("original_image_file_id") REFERENCES "file_storage"."files"("file_id") ON DELETE no action ON UPDATE no action;
