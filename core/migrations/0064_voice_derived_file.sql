-- 0064: 语音派生播放文件
-- 转码出的 MP3 之前只喂给 ASR、未落盘，前端拿到的是 audio/x-silk 原文件，
-- 浏览器/移动端均无法播放。新增 media.assets.derived_file_id 持久化转码产物，
-- 媒体内容端点优先返回派生文件。
ALTER TABLE media.assets
  ADD COLUMN derived_file_id VARCHAR(36) REFERENCES file_storage.files(file_id);
