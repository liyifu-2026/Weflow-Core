/**
 * Artifact integrity verification — the single implementation.
 *
 * Path-escape checks and sha256 digest verification used to exist in three
 * copies (old runner client, repo scripts, ad-hoc CLI logic). They now live
 * here only. Callers (`weflowctl`, repository scripts) must delegate to these
 * functions instead of re-implementing them.
 */
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type {
  SolutionLockV1,
  SolutionPackageDescriptor,
} from "./schema.js";

export type ArtifactRefVerification =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Verify that an artifact `ref` resolves to a path inside `lockDir`.
 *
 * Rejects empty refs, absolute paths, Windows drive letters, any `..`
 * segment (after normalising `\` to `/`) and any resolved path that escapes
 * `lockDir`. Returns the resolved absolute path on success.
 */
export function verifyArtifactRef(
  ref: string,
  lockDir: string,
): ArtifactRefVerification {
  const root = resolve(lockDir);
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return { ok: false, error: "ref_empty" };
  }
  let cleaned = ref;
  if (cleaned.startsWith("file:")) cleaned = cleaned.slice("file:".length);
  // Backslashes are accepted only as separators; normalise before checks so
  // `..\..\secret` is treated exactly like `../../secret`.
  cleaned = cleaned.replaceAll("\\", "/").replace(/^\.\//, "");
  if (cleaned.length === 0) return { ok: false, error: "ref_empty" };
  if (cleaned.startsWith("/")) return { ok: false, error: "ref_absolute" };
  if (/^[a-zA-Z]:/.test(cleaned)) return { ok: false, error: "ref_drive_letter" };
  const segments = cleaned.split("/");
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, error: "ref_parent_segment" };
  }
  if (segments.some((segment) => segment === "." || segment.length === 0)) {
    return { ok: false, error: "ref_invalid_segment" };
  }
  const candidate = resolve(root, ...segments);
  const rel = relative(root, candidate);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(root, rel) !== candidate
  ) {
    return { ok: false, error: "ref_escapes_lock_dir" };
  }
  return { ok: true, path: candidate };
}

/** Deterministic sha256 digest of a file or directory (sorted walk). */
export async function digestArtifactPath(
  path: string,
): Promise<{ digest: string; size: number }> {
  const info = statSync(path);
  if (info.isFile()) {
    const content = await readFile(path);
    return {
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      size: info.size,
    };
  }
  const files: string[] = [];
  await collectFiles(path, "", files);
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  let totalSize = 0;
  for (const relFile of files) {
    const content = await readFile(resolve(path, relFile));
    hash.update(relFile);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
    totalSize += content.byteLength;
  }
  return { digest: `sha256:${hash.digest("hex")}`, size: totalSize };
}

async function collectFiles(
  dir: string,
  prefix: string,
  out: string[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await collectFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`, out);
    } else if (entry.isFile()) {
      out.push(`${prefix}${entry.name}`);
    }
  }
}

export type VerifiedArtifact = {
  id: string;
  ref: string;
  path: string;
  digest: string;
  size: number;
};

/**
 * High-level gate: every lock entry must resolve inside `lockDir`, exist on
 * disk, and match its recorded sha256 digest and byte size. Throws a stable,
 * machine-readable error code on the first violation; returns the verified
 * artifact list on success.
 */
export async function assertSolutionArtifacts(
  descriptor: SolutionPackageDescriptor | { lock: SolutionLockV1 },
  lockDir: string,
): Promise<VerifiedArtifact[]> {
  const verified: VerifiedArtifact[] = [];
  for (const artifact of descriptor.lock.resolvedArtifacts) {
    const refCheck = verifyArtifactRef(artifact.ref, lockDir);
    if (!refCheck.ok) {
      throw new Error(`solution_artifact_path_escape:${artifact.id}:${artifact.ref}:${refCheck.error}`);
    }
    if (!existsSync(refCheck.path)) {
      throw new Error(`solution_artifact_missing:${artifact.id}`);
    }
    const actual = await digestArtifactPath(refCheck.path);
    if (actual.digest !== artifact.digest) {
      throw new Error(`solution_artifact_digest_mismatch:${artifact.id}`);
    }
    if (actual.size !== artifact.size) {
      throw new Error(`solution_artifact_size_mismatch:${artifact.id}`);
    }
    verified.push({
      id: artifact.id,
      ref: artifact.ref,
      path: refCheck.path,
      digest: actual.digest,
      size: actual.size,
    });
  }
  return verified;
}
