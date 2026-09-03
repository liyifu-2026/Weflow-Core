/**
 * 出站媒体暂存（outbound-media-staging）单元测试。
 *
 * 覆盖微信粘贴路线依赖的核心语义：
 * 1. 图片暂存后路径带真实图片扩展名（channel-host 按扩展名走图片草稿分支）；
 * 2. 文件暂存后接收方看到的是原始文件名（不再是 UUID）；
 * 3. 无扩展名图片按 MIME 推断补扩展名；
 * 4. 幂等：重复暂存同内容不破坏文件；
 * 5. 原名中的危险字符被净化。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupOutboundMediaStaging,
  stageOutboundMedia,
} from "../infrastructure/media/outbound-media-staging.js";

let root: string;

async function makeSource(
  name: string,
  bytes: Buffer,
): Promise<string> {
  const dir = join(root, "source");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "weflow-outbound-staging-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("stageOutboundMedia", () => {
  it("图片：暂存路径保留原始图片文件名与扩展名", async () => {
    const bytes = Buffer.from("png-bytes");
    const source = await makeSource("uuid-no-ext", bytes);
    const result = await stageOutboundMedia(root, {
      kind: "image",
      sourcePath: source,
      originalName: "产品照片.png",
      mimeType: "image/png",
      messageId: "manual-message:abc123",
      mediaIndex: 0,
    });
    expect(result.stagedFileName).toBe("产品照片.png");
    expect(result.stagedPath).toContain("media-outbound");
    expect(result.stagedPath.endsWith("产品照片.png")).toBe(true);
    const written = await readFile(result.stagedPath);
    expect(written.equals(bytes)).toBe(true);
  });

  it("图片：原名无扩展名时按 MIME 推断补 .jpg", async () => {
    const source = await makeSource("uuid2", Buffer.from("jpeg"));
    const result = await stageOutboundMedia(root, {
      kind: "image",
      sourcePath: source,
      originalName: "扫描件",
      mimeType: "image/jpeg",
      messageId: "msg-img-infer",
      mediaIndex: 0,
    });
    expect(result.stagedFileName).toBe("扫描件.jpg");
  });

  it("文件：暂存为原始文件名，接收方不再看到 UUID", async () => {
    const bytes = Buffer.from("pdf-bytes");
    const source = await makeSource("uuid3", bytes);
    const result = await stageOutboundMedia(root, {
      kind: "file",
      sourcePath: source,
      originalName: "报价单 2026.pdf",
      mimeType: "application/pdf",
      messageId: "msg-file",
      mediaIndex: 0,
    });
    expect(result.stagedFileName).toBe("报价单 2026.pdf");
    expect((await readFile(result.stagedPath)).equals(bytes)).toBe(true);
  });

  it("文件：无扩展名时兜底 .bin", async () => {
    const source = await makeSource("uuid4", Buffer.from("blob"));
    const result = await stageOutboundMedia(root, {
      kind: "file",
      sourcePath: source,
      originalName: "无类型数据",
      mimeType: "application/octet-stream",
      messageId: "msg-bin",
      mediaIndex: 0,
    });
    expect(result.stagedFileName).toBe("无类型数据.bin");
  });

  it("幂等：同路径同内容重复暂存成功且内容不变", async () => {
    const bytes = Buffer.from("stable-bytes");
    const source = await makeSource("uuid5", bytes);
    const input = {
      kind: "file" as const,
      sourcePath: source,
      originalName: "合同.pdf",
      mimeType: "application/pdf",
      messageId: "msg-idem",
      mediaIndex: 0,
    };
    const first = await stageOutboundMedia(root, input);
    const second = await stageOutboundMedia(root, input);
    expect(second.stagedPath).toBe(first.stagedPath);
    expect((await readFile(first.stagedPath)).equals(bytes)).toBe(true);
  });

  it("重传同名不同内容：暂存文件原子更新为新内容", async () => {
    const first = await makeSource("uuid6", Buffer.from("old-content"));
    const input = {
      kind: "file" as const,
      sourcePath: first,
      originalName: "报告.pdf",
      mimeType: "application/pdf",
      messageId: "msg-replace",
      mediaIndex: 0,
    };
    await stageOutboundMedia(root, input);
    const second = await makeSource("uuid7", Buffer.from("new-content"));
    const result = await stageOutboundMedia(root, { ...input, sourcePath: second });
    expect((await readFile(result.stagedPath)).toString()).toBe("new-content");
  });

  it("不同消息的同名附件落在隔离目录，互不覆盖", async () => {
    const sourceA = await makeSource("uuid8", Buffer.from("content-A"));
    const sourceB = await makeSource("uuid9", Buffer.from("content-B"));
    const a = await stageOutboundMedia(root, {
      kind: "file",
      sourcePath: sourceA,
      originalName: "同名.pdf",
      mimeType: "application/pdf",
      messageId: "msg-aaa",
      mediaIndex: 0,
    });
    const b = await stageOutboundMedia(root, {
      kind: "file",
      sourcePath: sourceB,
      originalName: "同名.pdf",
      mimeType: "application/pdf",
      messageId: "msg-bbb",
      mediaIndex: 0,
    });
    expect(a.stagedPath).not.toBe(b.stagedPath);
    expect((await readFile(a.stagedPath)).toString()).toBe("content-A");
    expect((await readFile(b.stagedPath)).toString()).toBe("content-B");
  });

  it("原名含路径分隔符/非法字符时被净化，不逃逸暂存目录", async () => {
    const source = await makeSource("uuid10", Buffer.from("safe"));
    const result = await stageOutboundMedia(root, {
      kind: "file",
      sourcePath: source,
      originalName: '..\\..\\evil<>:"|?.pdf',
      mimeType: "application/pdf",
      messageId: "msg-safe",
      mediaIndex: 0,
    });
    expect(result.stagedFileName).not.toContain("..\\");
    expect(result.stagedFileName).not.toContain(":");
    expect(result.stagedPath.startsWith(join(root, "media-outbound"))).toBe(true);
    await stat(result.stagedPath); // 文件确实存在
  });

  it("cleanupOutboundMediaStaging：删除暂存目录且对不存在目录静默成功", async () => {
    const source = await makeSource("uuid11", Buffer.from("x"));
    const result = await stageOutboundMedia(root, {
      kind: "file",
      sourcePath: source,
      originalName: "待清理.pdf",
      mimeType: "application/pdf",
      messageId: "msg-clean",
      mediaIndex: 0,
    });
    await cleanupOutboundMediaStaging(root, "msg-clean");
    await expect(stat(result.stagedPath)).rejects.toThrow();
    // 再次清理不抛错
    await cleanupOutboundMediaStaging(root, "msg-clean");
  });
});
