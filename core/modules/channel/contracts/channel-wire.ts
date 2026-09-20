/**
 * 通道 wire 类型编号与 wire 形态知识。
 *
 * 这些数字是历史通道协议的源类型编号（1 文本 / 3 图片 / 34 语音 /
 * 43 视频 / 49 文件），Channel Host 协议 v6 已改报 kind 语义字段；
 * 编号仅供 ingest 兜底落库（messages.type 列）使用，业务层不得解析。
 * 归属：通道契约层——conversations 等 Core 模块不持有 wire 知识。
 */

export const CHANNEL_WIRE_TYPES = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  VIDEO: 43,
  FILE: 49,
} as const;

/** 整条消息就是一个通道内部 id 的形态（user_ 前缀 + 长 token） */
export const BARE_CHANNEL_REF_RE = /^user_[A-Za-z0-9_-]{16,}$/;
