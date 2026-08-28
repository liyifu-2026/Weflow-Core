/**
 * Solution version health checks.
 *
 * A store-installed version is structurally healthy when its manifest parses
 * and every declared plugin artifact carries a loadable bundled entry point.
 * Runtime probes can be layered on via the `extraCheck` callback.
 */
import {
  describeSolution,
  type SolutionManifestV1,
} from "@weflow-leaif/solution-sdk";
import {
  artifactKind,
  normalizeRef,
  readManifestFile,
} from "./solution-stage.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

export type SolutionHealthResult = { ok: true } | { ok: false; reason: string };

export async function checkSolutionVersionHealth(
  versionDir: string,
  extraCheck?: (
    manifest: SolutionManifestV1,
    versionDir: string,
  ) => Promise<SolutionHealthResult>,
): Promise<SolutionHealthResult> {
  let manifest: SolutionManifestV1;
  try {
    const manifestInput = await readManifestFile(versionDir);
    manifest = describeSolution(manifestInput).manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `solution_manifest_invalid:${message}` };
  }

  for (const artifact of manifest.artifacts) {
    if (artifactKind(artifact) !== "plugin") continue;
    const entry = join(normalizeRef(artifact.ref), "dist", "plugin.js");
    if (!existsSync(join(versionDir, entry))) {
      return { ok: false, reason: `plugin_entry_missing:${artifact.id}` };
    }
  }

  if (extraCheck) return extraCheck(manifest, versionDir);
  return { ok: true };
}
