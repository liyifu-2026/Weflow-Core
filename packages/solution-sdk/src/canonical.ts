import { createHash } from "node:crypto";
import type { SolutionLockV1, SolutionManifestV1 } from "./types.js";

/**
 * 递归规范化对象：对象键按字典序排序，undefined 值不参与序列化。
 * 相同逻辑输入必须产生相同字符串，这是 planDigest 与签名的基础。
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = canonicalize(record[key]);
      if (item !== undefined) result[key] = item;
    }
    return result;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalStringify(value))}`;
}

export function manifestDigest(manifest: SolutionManifestV1): string {
  return digestOf(manifest);
}

export function lockDigest(lock: SolutionLockV1): string {
  return digestOf(lock);
}

/**
 * Deterministic digest for the payload carried by a Solution Operation.
 * This is the trust anchor used by Solution Runner to verify that the
 * manifest/lock it received matches the operation's planDigest.
 */
export function solutionPayloadDigest(
  manifest: SolutionManifestV1,
  lock: SolutionLockV1,
): string {
  return digestOf({ manifest, lock });
}
