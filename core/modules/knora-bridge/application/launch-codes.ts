/**
 * knora bridge 一次性 code 暂存（application 层）。
 *
 * 单进程内存（launch 与 redirect 两种入口共享同一份暂存）；
 * TTL 60s，消费即删除。测试可通过 resetLaunchCodes() 隔离。
 */
import { randomBytes } from "node:crypto";

const CODE_TTL_MS = 60_000;

type LaunchCode = { userId: string; expiresAt: number };

const codes = new Map<string, LaunchCode>();

/** 签发一次性 code（60s TTL） */
export function issueCode(userId: string): string {
  const code = randomBytes(24).toString("base64url");
  codes.set(code, { userId, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/** 消费 code：返回 userId 或 null（不存在/过期/已消费） */
export function consumeCode(code: string): string | null {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  return entry.expiresAt >= Date.now() ? entry.userId : null;
}

/** 测试辅助：清空 code 暂存，避免跨用例污染 */
export function resetLaunchCodes(): void {
  codes.clear();
}
