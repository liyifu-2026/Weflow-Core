/**
 * 上传文件类型底线策略（平台级、业务中立）。
 *
 * 出站媒体/素材上传不做格式白名单（客服场景需要任意文档、压缩包、
 * 音视频），但拒绝可执行文件与双击即运行的脚本：它们只会以「下载后用
 * 系统程序打开」的形态落到收件人机器上，误点即执行，客服场景没有正当
 * 用途。这是黑名单而非白名单，新增格式默认放行。
 */

/** 可执行文件 / 双击即运行的脚本扩展名（小写，不含点） */
const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "msi",
  "msix",
  "bat",
  "cmd",
  "com",
  "scr",
  "pif",
  "cpl",
  "dll",
  "sys",
  "lnk",
  "reg",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  "jar",
  "apk",
  "app",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "sh",
]);

/** 明确的二进制可执行 MIME（部分客户端不带扩展名） */
const BLOCKED_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-dosexec",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
  "application/x-msi",
  "application/x-sh",
  "application/x-bat",
  "application/java-archive",
  "application/vnd.android.package-archive",
]);

/** 上传被策略拒绝（路由层映射为 415 upload_type_blocked） */
export class UploadTypeBlockedError extends Error {
  readonly code = "upload_type_blocked";
  readonly originalName: string;

  constructor(originalName: string) {
    super(`upload_type_blocked:${originalName}`);
    this.name = "UploadTypeBlockedError";
    this.originalName = originalName;
  }
}

/** 取文件名扩展名（小写、不含点；无扩展名返回空串） */
export function extensionOf(originalName: string): string {
  const index = originalName.lastIndexOf(".");
  return index > 0 ? originalName.slice(index + 1).toLowerCase() : "";
}

/** 校验通过则返回；命中黑名单抛 UploadTypeBlockedError */
export function assertUploadAllowed(input: {
  originalName: string;
  mimeType: string;
}): void {
  const extension = extensionOf(input.originalName);
  const mimeType = (input.mimeType || "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (BLOCKED_EXTENSIONS.has(extension) || BLOCKED_MIME_TYPES.has(mimeType)) {
    throw new UploadTypeBlockedError(input.originalName);
  }
}
