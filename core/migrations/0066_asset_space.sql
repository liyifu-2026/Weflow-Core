-- 0066: 素材空间（Asset Space）
-- 平台级、业务中立的素材库：上传时持久持有文件（file_storage.files 持久引用，
-- 区别于 manual-upload 的"临时持有"语义），支持图片/文件两个分类维度，
-- 供会话发送时从空间中选择已有素材直接转发，无需重新上传文件字节。
-- 约定：
--   * category 仅 'image' | 'file'（按上传 MIME 推导，与 media 模块 MIME_KIND 约定一致）
--   * deleted_at 软删除：列表默认过滤；物理文件随 storedFiles 生命周期统一治理
--   * 来源仅"本机上传"（HTTP multipart）；未来扩 URL 拉取/网盘挂载时加 source 列
CREATE SCHEMA IF NOT EXISTS "assets";

CREATE TABLE assets.items (
  asset_id VARCHAR(36) PRIMARY KEY,
  file_id VARCHAR(36) NOT NULL REFERENCES file_storage.files(file_id),
  category VARCHAR(20) NOT NULL,        -- 'image' | 'file'
  name VARCHAR(255) NOT NULL,           -- 显示名（可整理改名）
  mime_type VARCHAR(200) NOT NULL,
  size BIGINT NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  created_by_user_id VARCHAR(36) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX assets_items_list_idx ON assets.items (category, deleted_at, created_at DESC);
CREATE INDEX assets_items_name_idx ON assets.items (name varchar_pattern_ops);
CREATE INDEX assets_items_creator_idx ON assets.items (created_by_user_id);
