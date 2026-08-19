/**
 * 本地文件存储
 * 提供文件的写入、读取和删除操作
 * 文件按 storageKey 组织，使用 UUID 作为文件名
 * 写入时计算 SHA256 校验和，支持原子写入（临时文件 + rename）
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** 文件写入结果类型 */
export type StoredFileWrite = {
  fileId: string;
  originalName: string;
  mimeType: string;
  size: number;
  checksum: string;
  storageKey: string;
};

/** 本地文件存储类 */
export class LocalFileStorage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /**
   * 写入文件
   * @param source - 可读流
   * @param originalName - 原始文件名
   * @param mimeType - MIME 类型
   * @returns 文件元数据（ID、校验和、存储键等）
   */
  async write(
    source: NodeJS.ReadableStream,
    originalName: string,
    mimeType: string,
  ): Promise<StoredFileWrite> {
    const fileId = randomUUID();
    const storageKey = join(fileId.slice(0, 2), fileId);
    const finalPath = this.path(storageKey);
    const temporaryPath = `${finalPath}.uploading`;
    await mkdir(resolve(finalPath, ".."), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        source,
        meter,
        createWriteStream(temporaryPath, { flags: "wx" }),
      );
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return {
      fileId,
      originalName: basename(originalName).slice(0, 500),
      mimeType,
      size,
      checksum: hash.digest("hex"),
      storageKey,
    };
  }

  /** 删除文件 */
  async remove(storageKey: string): Promise<void> {
    await unlink(this.path(storageKey)).catch(() => undefined);
  }

  /** 读取文件（返回可读流） */
  read(storageKey: string): NodeJS.ReadableStream {
    return createReadStream(this.path(storageKey));
  }

  /** 文件是否真实存在（内容端点出图前的兜底检查，缺失时返回 404 而非 500） */
  async exists(storageKey: string): Promise<boolean> {
    try {
      await stat(this.path(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  private path(storageKey: string): string {
    const path = resolve(this.#root, storageKey);
    const relativePath = relative(this.#root, path);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new Error("invalid storage key");
    }
    return path;
  }
}
