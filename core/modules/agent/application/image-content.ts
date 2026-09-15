/**
 * 图片 → 多模态 content 段（Phase 4 视觉直读）。
 *
 * 决策模型直接看图：把已落盘的图片字节转成 data URI 注入 user 消息的
 * image_url 段（自包含，不依赖外部可访问 URL；范式同 MimoVisionClient）。
 *
 * 仅当外部显式启用（agent-worker 注入 storage + 开关开启）时才会被调用；
 * 任何读取失败/超限一律回落 null，由调用方保持既有文本占位，绝不阻断轮次。
 */

import type { Readable } from "node:stream";
import type { FileStorage } from "../../../infrastructure/file_storage/types.js";

/** 主模型识图用原图字节上限：超过回退缩略图（防 token 放大/端侧超时） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 把存储键流读成 Buffer（读失败返回 null，不抛）。 */
async function readBuffer(
  storage: FileStorage,
  storageKey: string,
): Promise<Buffer | null> {
  try {
    const stream = storage.read(storageKey) as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return null;
    return buffer;
  } catch {
    return null;
  }
}

/**
 * 把一张已落盘图片转成消息中的 image_url 段。
 *
 * preferredFileId 优先（通常是原图 originalImageFileId，清晰度最高）；
 * fallbackFileId 是在原图缺失/超限时用于回退的存档文件（originalFileId，
 * 可能是缩略图或首下载）。没有可读文件时返回 null（调用方走文本占位）。
 */
export async function imageToContentPart(
  storage: FileStorage,
  preferredFileId: string | null,
  fallbackFileId: string | null,
  mimeType: string | null,
): Promise<{ type: "image_url"; image_url: { url: string } } | null> {
  const candidates = [preferredFileId, fallbackFileId].filter(
    (id): id is string => Boolean(id),
  );
  for (const fileId of candidates) {
    const buffer = await readBuffer(storage, fileId);
    if (!buffer) continue;
    const mime = mimeType && /^image\//.test(mimeType) ? mimeType : "image/png";
    const url = `data:${mime};base64,${buffer.toString("base64")}`;
    return { type: "image_url", image_url: { url } };
  }
  return null;
}

export type ImageSegmentBuilder = typeof imageToContentPart;