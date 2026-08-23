/**
 * Solution backup (export) and restore (import).
 *
 * export  : tar the store's active version directory — the package already
 *           carries manifest+lock+signature, so the backup is verifiable.
 * import  : verify the backup through the normal install path and re-activate
 *           it; refuse to silently overwrite a diverging active version.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import {
  describeStagedSolutionPackage,
  installSolutionPackage,
  type InstallSolutionPackageOptions,
} from "./solution-pack.js";
import {
  activateSolution,
  getSolutionStoreRoot,
  readActiveVersion,
} from "./solution-store.js";

export async function exportSolutionBackup(
  solutionId: string,
  outputPath: string,
): Promise<{ solutionId: string; version: string; path: string }> {
  const version = await readActiveVersion(solutionId);
  if (!version) {
    throw new Error(`solution_not_active:${solutionId}`);
  }
  // Tar the real version directory (not the junction): node-tar does not
  // recurse into "." when cwd is a Windows junction.
  const versionDir = join(getSolutionStoreRoot(), solutionId, version);
  if (!existsSync(versionDir)) {
    throw new Error(`solution_version_not_in_store:${solutionId}:${version}`);
  }
  await mkdir(join(outputPath, ".."), { recursive: true });
  await tar.c(
    { gzip: true, file: outputPath, cwd: versionDir, portable: true },
    ["."],
  );
  return { solutionId, version, path: outputPath };
}

export async function importSolutionBackup(
  backupPath: string,
  options: InstallSolutionPackageOptions & { force?: boolean },
): Promise<{ solutionId: string; version: string; activated: boolean }> {
  // Peek at the backup contents to learn id/version before touching the store.
  const staging = await mkdtemp(join(tmpdir(), "weflow-import-"));
  try {
    const peekDir = join(staging, "pkg");
    await mkdir(peekDir, { recursive: true });
    await tar.x({ file: backupPath, cwd: peekDir });
    const descriptor = await describeStagedSolutionPackage(peekDir);
    const solutionId = descriptor.manifest.metadata.id;
    const version = descriptor.manifest.metadata.version;

    const active = await readActiveVersion(solutionId);
    if (!options.force && active !== null && active !== version) {
      throw new Error(`solution_import_conflict:${solutionId}:${active}`);
    }

    // Install through the verified path against the original tarball bytes.
    const tarballCopy = join(staging, "backup.tgz");
    await copyFile(backupPath, tarballCopy);
    const result = await installSolutionPackage(tarballCopy, options);
    await activateSolution(solutionId, version);
    return {
      solutionId: result.solutionId,
      version: result.version,
      activated: true,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
