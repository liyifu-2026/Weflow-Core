/**
 * Solution package staging: filtered copy + plugin bundling.
 *
 * Staging turns a solution source tree into a self-contained package
 * directory: plugin entries are bundled with esbuild into `dist/plugin.js`
 * so the result never depends on the source workspace's node_modules.
 */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import * as esbuild from "esbuild";
import {
  digestArtifactPath,
  type SolutionManifestV1,
} from "@weflow-leaif/solution-sdk";

export const STAGE_EXCLUDED = new Set([
  "node_modules",
  ".git",
  ".data",
  ".expo",
  ".scratch",
  "android",
  "build",
  "dist-test",
  "coverage",
  "solution.lock.json",
  "signature.json",
]);

/**
 * Copy a solution source tree into a fresh staging directory and bundle every
 * declared plugin into a self-contained `dist/plugin.js`. The returned
 * directory has no dependency on the source workspace.
 */
export async function stagePackagedSolution(
  sourceDir: string,
): Promise<string> {
  const resolvedSource = resolve(sourceDir);
  if (
    !existsSync(join(resolvedSource, "solution.manifest.json")) &&
    !existsSync(join(resolvedSource, "solution.manifest.yaml"))
  ) {
    throw new Error(`solution_manifest_not_found:${resolvedSource}`);
  }
  const staging = await mkdtemp(join(tmpdir(), "weflow-solution-stage-"));
  await copyFiltered(resolvedSource, staging);
  const manifest = await readManifestFile(resolvedSource);
  for (const artifact of manifest.artifacts) {
    if (artifactKind(artifact) !== "plugin") continue;
    await bundlePluginArtifact(resolvedSource, staging, artifact);
  }
  return staging;
}

export async function copyFiltered(
  source: string,
  dest: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (STAGE_EXCLUDED.has(entry.name)) continue;
    if (entry.isDirectory()) {
      await copyFiltered(join(source, entry.name), join(dest, entry.name));
    } else if (entry.isFile()) {
      await mkdir(dest, { recursive: true });
      await copyFile(join(source, entry.name), join(dest, entry.name));
    }
  }
}

export function artifactKind(
  artifact: SolutionManifestV1["artifacts"][number],
): string | null {
  if ("kind" in artifact && typeof artifact.kind === "string") {
    return artifact.kind;
  }
  const legacy = artifact as unknown as { type?: string };
  if (legacy.type === "plugin") return "plugin";
  return null;
}

export function artifactRef(
  artifact: SolutionManifestV1["artifacts"][number],
): string {
  return artifact.ref;
}

export function normalizeRef(ref: string): string {
  const cleaned = ref.startsWith("file:") ? ref.slice("file:".length) : ref;
  return cleaned.replace(/^\.\//, "").replace(/^\./, "");
}

async function bundlePluginArtifact(
  sourceDir: string,
  stagingDir: string,
  artifact: SolutionManifestV1["artifacts"][number],
): Promise<void> {
  const relDir = normalizeRef(artifactRef(artifact));
  const sourcePluginDir = join(sourceDir, relDir);
  const entry = await findPluginEntry(sourcePluginDir);
  if (!entry) {
    throw new Error(`solution_plugin_entry_not_found:${artifact.id}:${relDir}`);
  }
  const outfile = join(stagingDir, relDir, "dist", "plugin.js");
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
}

async function findPluginEntry(pluginDir: string): Promise<string | null> {
  const srcEntry = join(pluginDir, "src", "plugin.ts");
  if (existsSync(srcEntry)) return srcEntry;
  const packageJsonPath = join(pluginDir, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(
        await readFile(packageJsonPath, "utf8"),
      ) as {
        main?: string;
        module?: string;
      };
      for (const candidate of [packageJson.module, packageJson.main]) {
        if (candidate && existsSync(join(pluginDir, candidate))) {
          return join(pluginDir, candidate);
        }
      }
    } catch {
      // fall through to dist default
    }
  }
  const distEntry = join(pluginDir, "dist", "plugin.js");
  return existsSync(distEntry) ? distEntry : null;
}

/** Read a solution manifest file (JSON subset of YAML; never permissive). */
export async function readManifestFile(
  dir: string,
): Promise<SolutionManifestV1> {
  const yamlPath = join(dir, "solution.manifest.yaml");
  const jsonPath = join(dir, "solution.manifest.json");
  const path = existsSync(yamlPath)
    ? yamlPath
    : existsSync(jsonPath)
      ? jsonPath
      : null;
  if (!path) throw new Error(`solution_manifest_not_found:${dir}`);
  const text = (await readFile(path, "utf8")).trim();
  // JSON is a strict subset of YAML and the only accepted format until the
  // dedicated YAML adapter lands. Never guess at a permissive YAML parse.
  if (!text.startsWith("{")) throw new Error("yaml_adapter_required");
  return JSON.parse(text) as SolutionManifestV1;
}

/** Digest a staged file or directory deterministically (SDK implementation). */
export async function digestPath(
  path: string,
): Promise<{ digest: string; size: number }> {
  return digestArtifactPath(path);
}
