/**
 * 文件存储 seam（平台级抽象）
 *
 * 存储驱动的最小接口：写入（含元数据）、读取、存在性检查、删除。
 * 当前唯一实现是 LocalFileStorage（本地磁盘）；未来对象存储（S3/OSS 等）
 * 驱动实现同一接口即可替换，modules 层不感知具体驱动。
 */
import type { StoredFileWrite } from "./local-file-storage.js";

export type { StoredFileWrite };

export interface FileStorage {
  /** 写入文件并返回元数据（fileId、storageKey、校验和等） */
  write(
    source: NodeJS.ReadableStream,
    originalName: string,
    mimeType: string,
  ): Promise<StoredFileWrite>;
  /** 删除文件（缺失时静默成功，与 LocalFileStorage 语义一致） */
  remove(storageKey: string): Promise<void>;
  /** 读取文件流 */
  read(storageKey: string): NodeJS.ReadableStream;
  /** 文件是否真实存在 */
  exists(storageKey: string): Promise<boolean>;
}
