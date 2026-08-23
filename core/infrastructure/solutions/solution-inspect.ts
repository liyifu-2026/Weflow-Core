/**
 * `weflowctl solution inspect` 鈥?look inside a package (tgz or directory)
 * without installing: manifest summary, lock, signature, file listing and
 * size digest.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  describeStagedSolutionPackage,
  extractSolutionTgz,
} from "./solution-pack.js";

export type InspectedFile = {
  path: string;
  size: number;
};

export type PackageInspection = {
  sourcePath: string;
  solutionId: string;
  version: string;
  publisher: string;
  signatureKeyId: string;
  manifestDigest: string;
  lockDigest?: string | undefined;
  applications: string[];
  artifactCount: number;
  resourceCount: number;
  files: InspectedFile[];
  totalSize: number;
  lock?:
    | {
        resolvedArtifacts: Array<{
          id: string;
          ref: string;
          digest: string;
          size: number;
        }>;
      }
    | undefined;
  signature: { keyId: string; algorithm: string };
};

/** Inspect a packaged tarball or an extracted package directory. */
export async function inspectPackage(
  packagePath: string,
): Promise<PackageInspection> {
  const isTgz =
    /\.(tgz|tar\.gz)$/i.test(packagePath) || packagePath.endsWith(".tgz");
  let extractedTo: string | null = null;
  try {
    let dir = packagePath;
    if (isTgz) {
      extractedTo = await mkdtemp(join(tmpdir(), "weflow-inspect-"));
      dir = await extractSolutionTgz(packagePath, extractedTo);
    } else {
      // Validate presence up front for a stable error code.
      if (
        !existsSync(join(dir, "solution.manifest.yaml")) &&
        !existsSync(join(dir, "solution.manifest.json"))
      ) {
        throw new Error(`solution_manifest_not_found:${dir}`);
      }
    }
    const descriptor = await describeStagedSolutionPackage(dir);
    const manifest = descriptor.manifest;
    const files = await collectFiles(dir);
    const totalSize = files.reduce((sum, item) => sum + item.size, 0);
    return {
      sourcePath: packagePath,
      solutionId: manifest.metadata.id,
      version: manifest.metadata.version,
      publisher: manifest.metadata.publisher,
      signatureKeyId: descriptor.signature.keyId,
      manifestDigest: descriptor.manifestDigest,
      ...(descriptor.lockDigest !== undefined
        ? { lockDigest: descriptor.lockDigest }
        : {}),
      applications: manifest.applications.map((item) => item.id),
      artifactCount: manifest.artifacts.length,
      resourceCount: manifest.resources.length,
      files,
      totalSize,
      lock: {
        resolvedArtifacts: descriptor.lock.resolvedArtifacts.map((item) => ({
          id: item.id,
          ref: item.ref,
          digest: item.digest,
          size: item.size,
        })),
      },
      signature: {
        keyId: descriptor.signature.keyId,
        algorithm: descriptor.signature.algorithm,
      },
    };
  } finally {
    if (extractedTo) {
      const { rm } = await import("node:fs/promises");
      await rm(extractedTo, { recursive: true, force: true });
    }
  }
}

async function collectFiles(root: string): Promise<InspectedFile[]> {
  const out: InspectedFile[] = [];
  await walk(root, "", out);
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(
  dir: string,
  prefix: string,
  out: InspectedFile[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      await walk(join(dir, entry.name), `${relative}/`, out);
    } else if (entry.isFile()) {
      const info = await stat(join(dir, entry.name));
      out.push({ path: relative, size: info.size });
    }
  }
}
