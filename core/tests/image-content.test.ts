/**
 * image-content 单元测试（Phase 4 视觉直读）：
 * - 把已落盘图片字节转成 data URI image_url 段
 * - 原图缺失/读失败 → 回落 null（不阻断轮次）
 * - 大小超限 → 回落 null
 */
import { describe, expect, it } from "vitest";
import { Readable as NodeReadable } from "node:stream";
import type { FileStorage } from "../infrastructure/file_storage/types.js";
import { imageToContentPart } from "../modules/agent/application/image-content.js";

class FakeStorage implements FileStorage {
  constructor(
    private readonly files: Record<string, Buffer>,
    private readonly failKeys: Set<string> = new Set(),
  ) {}
  write() {
    return Promise.reject(new Error("not used"));
  }
  remove() {
    return Promise.resolve();
  }
  exists(storageKey: string): Promise<boolean> {
    return Promise.resolve(this.files[storageKey] !== undefined);
  }
  read(storageKey: string): NodeJS.ReadableStream {
    if (this.failKeys.has(storageKey)) {
      throw new Error(`boom on ${storageKey}`);
    }
    const buf = this.files[storageKey];
    if (!buf) throw new Error(`not found ${storageKey}`);
    return NodeReadable.from([buf]);
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("imageToContentPart", () => {
  it("读取原图字节并转成 data URI image_url 段", async () => {
    const storage = new FakeStorage({ "aa/orig": PNG });
    const part = await imageToContentPart(storage, "aa/orig", null, "image/png");
    expect(part).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` },
    });
  });

  it("原图缺失时回退存档文件", async () => {
    const storage = new FakeStorage({ "aa/fallback": PNG });
    const part = await imageToContentPart(
      storage,
      "aa/missing",
      "aa/fallback",
      "image/png",
    );
    expect(part).not.toBeNull();
  });

  it("两个文件都读不到时返回 null（不抛错）", async () => {
    const storage = new FakeStorage({});
    const part = await imageToContentPart(
      storage,
      "aa/nope",
      "aa/also-nope",
      "image/png",
    );
    expect(part).toBeNull();
  });

  it("读取抛错时返回 null（不阻断轮次）", async () => {
    const storage = new FakeStorage({}, new Set(["aa/broken"]));
    const part = await imageToContentPart(
      storage,
      "aa/broken",
      null,
      "image/png",
    );
    expect(part).toBeNull();
  });

  it("超大文件（>10MB）返回 null，避免喂给模型", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    const storage = new FakeStorage({ "aa/big": big });
    const part = await imageToContentPart(storage, "aa/big", null, "image/png");
    expect(part).toBeNull();
  });

  it("mime 非 image/* 时回落默认 image/png 前缀", async () => {
    const storage = new FakeStorage({ "aa/orig": PNG });
    const part = await imageToContentPart(storage, "aa/orig", null, "video/mp4");
    expect(part?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });
});