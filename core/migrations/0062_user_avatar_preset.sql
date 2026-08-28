-- 客服头像：平台预设头像（avatar_preset，见 identity/avatar-presets 模块）
-- 展示优先级：自定义上传 avatar_file_id > 平台预设 avatar_preset > 按用户名哈希的默认预设
ALTER TABLE "identity"."users" ADD COLUMN "avatar_preset" text;
