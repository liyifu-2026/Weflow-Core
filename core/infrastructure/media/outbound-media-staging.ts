/**
 * 出站媒体暂存（Outbound Media Staging）
 *
 * 微信粘贴发送路线（channel-host-wechat guia.py `_paste_attachment_and_send`）
 * 依赖真实文件名判断消息类型：图片按扩展名（.png/.jpg/...）走「图片草稿
 * 检测 + 重试」分支，文件按原名呈现给接收方。而 LocalFileStorage 落盘的
 * 是无扩展名的 UUID 文件（storageKey = fileId[0:2]/fileId），originalName
 * 只存在数据库里。
 *
 * 出站轮询在把媒体消息投递给 Channel Host 之前，把原始文件复制到本模块
 * 管理的暂存目录，文件名还原为净化后的原始文件名：
 *
 *   <root>/media-outbound/<messageId>[-<n>]/<sanitized originalName>
 *
 * 同一文件名多次出站（例如「合同.pdf」发给多个客户）落在以 messageId
 * 命名、彼此隔离的暂存目录中，永不互相覆盖；messageId 内的非法字符
 * （manual-message: 前缀含冒号）做归一化。复制幂等：同内容 + 同目标名
 * 跳过重写；目标已存在但内容不一致（重传同名不同文件）时原子重写。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** 消息ID中不允许出现在目录名里的字符（冒号等）→ 折叠为 `_`。 */
const UNSAFE_DIRECTORY_CHARS = /[^A-Za-z0-9._-]+/g;

type OutboundStagingKind = "image" | "file";

export type OutboundStagingInput = {
  /** 媒体种类（决定兜底扩展名策略：图片按 MIME 推断，文件兜底 .bin） */
  kind: OutboundStagingKind;
  /** 存储层落盘文件的绝对路径（UUID 无扩展名） */
  sourcePath: string;
  /** 数据库中的原始文件名（stored_files.original_name） */
  originalName: string;
  /** MIME 类型（图片缺扩展名时用于推断） */
  mimeType: string;
  /** 出站消息 ID（暂存子目录名，隔离不同消息的同名附件） */
  messageId: string;
  /** 同一消息内的去重序号（多个附件时区分，0 起） */
  mediaIndex: number;
};export type OutboundStagingResult = {
  /** 供 send operation payload 使用的暂存文件绝对路径（原名+扩展名） */
  stagedPath: string;
  /** 实际写出的文件名（净化 + 兜底扩展名之后） */
  stagedFileName: string;
};

/**
 * 把媒体文件以「原始文件名」复制进确定性暂存目录，返回可发送路径。
 *
 * - 幂等：同路径 + 同内容跳过复制；
 * - 失败向上抛出，由出站轮询的错误语义统一处理（本轮跳过、下轮重试）。
 */
export async function stageOutboundMedia(
  root: string,
  input: OutboundStagingInput,
): Promise<OutboundStagingResult> {
  const directoryName = normalizeDirectoryComponent(
    `${input.messageId}---${input.mediaIndex}`,
  );
  const directory = join(root, "media-outbound", directoryName);
  const stagedFileName = buildStagedFileName(
    input.originalName,
    input.kind,
    input.mimeType,
  );
  const stagedPath = join(directory, stagedFileName);

  await mkdir(directory, { recursive: true });

  if (await filesMatch(stagedPath, input.sourcePath)) {
    return { stagedPath, stagedFileName };
  }
  // 上一次中断可能留下 .staging 半成品；清掉后原子复制
  await rm(`${stagedPath}.staging`, { force: true });
  await copyFile(input.sourcePath, `${stagedPath}.staging`);
  // Windows 上 rename 不能覆盖已存在目标，先删旧目标再原子改名
  await rm(stagedPath, { force: true });
  await rename(`${stagedPath}.staging`, stagedPath);
  return { stagedPath, stagedFileName };
}

/** 删除某条消息的出站暂存目录（发送终态后清理；不存在的目录静默成功）。 */
export async function cleanupOutboundMediaStaging(
  root: string,
  messageId: string,
): Promise<void> {
  const directoryName = normalizeDirectoryComponent(`${messageId}---0`);
  await rm(join(root, "media-outbound", directoryName), {
    force: true,
    recursive: true,
  });
}

/** 尽力而为版清理：失败不抛错（清理失败不影响发送状态机，残留无害）。 */
export async function tryCleanupOutboundMediaStaging(
  root: string,
  messageId: string,
): Promise<void> {
  try {
    await cleanupOutboundMediaStaging(root, messageId);
  } catch {
    // 目录残留无害：同名下轮询会命中 content-match 幂等路径。
  }
}

/** 目录名安全化：仅保留字母数字与 . _ -，其余折叠为下划线并截断长度。 */
function normalizeDirectoryComponent(value: string): string {
  const normalized = value.replace(UNSAFE_DIRECTORY_CHARS, "_").slice(0, 120);
  return normalized.length > 0 ? normalized : "message";
}

/**
 * 构建暂存文件名：净化原名 + 兜底扩展名。
 * 图片：扩展名可信时保留；否则按 MIME 推断补扩展名（无 MIME 证据时保持原名）。
 * 文件：无扩展名时兜底 .bin（微信粘贴路线依赖扩展名/关联判定文件类型）。
 */
function buildStagedFileName(
  originalName: string,
  kind: OutboundStagingKind,
  mimeType: string,
): string {
  const base = sanitizeFileName(originalName);
  if (kind === "image") {
    if (IMAGE_EXTENSIONS.has(extensionOf(base))) return base;
    const inferred = imageExtensionForMime(mimeType);
    return inferred ? `${base}${inferred}` : base;
  }
  return extensionOf(base) ? base : `${base}.bin`;
}

/** 文件名净化：去路径、替换 Windows 非法字符、去前导点、限长、防空。 */
function sanitizeFileName(originalName: string): string {
  const base = originalName.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "attachment";
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  if (index <= 0 || index === fileName.length - 1) return "";
  return fileName.slice(index + 1).toLowerCase();
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp"]);

function imageExtensionForMime(mimeType: string): string | null {
  switch ((mimeType || "").toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/bmp":
      return ".bmp";
    case "image/webp":
      return ".webp";
    default:
      return null;
  }
}

/** 内容一致性判断：存在性 + 大小 + SHA-256，用于复制幂等。 */
async function filesMatch(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([
    stat(a).catch(() => null),
    stat(b).catch(() => null),
  ]);
  if (!statA || !statB || !statA.isFile() || !statB.isFile()) return false;
  if (statA.size !== statB.size) return false;
  return (await sha256File(a)) === (await sha256File(b));
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}
