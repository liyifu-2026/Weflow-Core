/**
 * npm-to-solution wrapper: turns a plain npm package into a solution package.
 *
 * When an npm package under the configured scope does not carry its own
 * `solution.manifest.json` (the common case for individual plugin packages),
 * this module synthesises a minimal manifest, generates the lock and
 * signature, and returns a directory that the standard install pipeline
 * can verify and copy into the store.
 */
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  defaultDevSigningKeyPath,
  describeStagedSolution,
  generateSigningKey,
  signSolutionPackage,
  writeSolutionLock,
} from "./solution-pack.js";

export type WrapNpmPackageResult = {
  /** Path to the synthetic solution package directory. */
  wrapDir: string;
  /** Solution id derived from the npm package name. */
  solutionId: string;
  /** Version from the npm package. */
  version: string;
  /** Whether the package already had a manifest (no wrapping needed). */
  alreadySolution: boolean;
};

/**
 * Inspect an extracted npm package directory. If it already has a
 * `solution.manifest.json`, return it as-is. Otherwise, create a minimal
 * solution package around it.
 *
 * The caller is responsible for cleaning up the returned `wrapDir` when it
 * differs from the input `npmExtractDir`.
 */
export async function ensureSolutionPackageFromNpm(
  npmExtractDir: string,
  packageName: string,
  version: string,
): Promise<WrapNpmPackageResult> {
  const hasManifest =
    existsSync(join(npmExtractDir, "solution.manifest.json")) ||
    existsSync(join(npmExtractDir, "solution.manifest.yaml"));

  if (hasManifest) {
    return {
      wrapDir: npmExtractDir,
      solutionId: packageName,
      version,
      alreadySolution: true,
    };
  }

  // Read the npm package.json for metadata.
  let npmPkgJson: {
    name?: string;
    version?: string;
    description?: string;
    author?: string | { name?: string };
    main?: string;
  } = {};
  try {
    npmPkgJson = JSON.parse(
      await readFile(join(npmExtractDir, "package.json"), "utf8"),
    );
  } catch {
    throw new Error(
      `npm_package_invalid:${packageName}:missing_package_json`,
    );
  }

  // Derive a solution id from the npm package name.
  // @weflow-leaif/customer-support-strategy -> weflow.customer-support-strategy
  const scopeMatch = /^@[^/]+\/(.+)$/.exec(packageName);
  const shortName = scopeMatch?.[1] ?? packageName.replace(/^@/, "");
  const solutionId = `weflow.${shortName}`;
  const publisher =
    typeof npmPkgJson.author === "object"
      ? (npmPkgJson.author.name ?? "weflow-leaif")
      : (npmPkgJson.author || "weflow-leaif");
  const description = npmPkgJson.description ?? `${shortName} plugin`;

  // Create a temp directory for the synthetic solution package.
  const wrapDir = await mkdtemp(join(tmpdir(), "weflow-npm-wrap-"));
  const pluginDir = join(wrapDir, "plugins", shortName);
  await cp(npmExtractDir, pluginDir, { recursive: true });

  // Build the minimal manifest.
  const manifest = {
    apiVersion: "weflow.io/v1",
    kind: "Solution",
    metadata: {
      id: solutionId,
      name: npmPkgJson.name ?? packageName,
      version: npmPkgJson.version ?? version,
      publisher,
      description,
    },
    compatibility: {
      platform: ">=1.0.0 <2.0.0",
      pluginSdk: "^1.0.0",
    },
    dependencies: {
      capabilities: [],
      solutions: [],
    },
    artifacts: [
      {
        id: shortName,
        kind: "plugin",
        ref: `file:./plugins/${shortName}`,
      },
    ],
    permissions: [],
    configuration: { defaults: {} },
    secretSlots: [],
    resources: [],
    executionProfiles: [],
    applications: [],
    healthChecks: [],
    consoleExtensions: [],
  };

  await writeFile(
    join(wrapDir, "solution.manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  // Generate lock + signature via the existing pack infrastructure.
  await writeSolutionLock(wrapDir, manifest);
  const descriptor = await describeStagedSolution(wrapDir);
  const { keyPair } = await generateSigningKey(defaultDevSigningKeyPath());
  const signature = signSolutionPackage(
    descriptor,
    keyPair.privateKeyPem,
    "weflow-dev",
  );
  await writeFile(
    join(wrapDir, "signature.json"),
    JSON.stringify(signature, null, 2),
    "utf8",
  );

  return {
    wrapDir,
    solutionId,
    version: npmPkgJson.version ?? version,
    alreadySolution: false,
  };
}
