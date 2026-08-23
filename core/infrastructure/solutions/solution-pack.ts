/**
 * Solution packaging: lock generation, signing, tgz, verified install.
 *
 * A packaged Solution is a self-contained directory (or .tgz of one) holding:
 *   solution.manifest.yaml|json   - the solution manifest (JSON subset of YAML)
 *   solution.lock.json            - resolved artifact digests (immutability)
 *   signature.json                - ed25519 signature over manifest+lock digests
 *   plugins/.../dist/plugin.js    - bundled, dependency-free plugin entry points
 *
 * The store only ever installs staged packages; it never re-resolves
 * workspace dependencies from a source checkout.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import * as tar from "tar";
import {
  describeSolution,
  parseSolutionLock,
  sha256Digest,
  solutionSignatureSchema,
  verifySolutionSignature,
  type SolutionDescriptor,
  type SolutionLockV1,
  type SolutionPackageDescriptor,
  type SolutionSignature,
} from "@weflow/solution-sdk";
import { installSolutionToStore } from "./solution-store.js";
import {
  artifactRef,
  digestPath,
  normalizeRef,
  readManifestFile,
  stagePackagedSolution,
} from "./solution-stage.js";

export type SigningKeyPair = {
  privateKeyPem: string;
  publicKeyPem: string;
};

/**
 * Default development signing key location.
 *
 * The trust anchor is machine-level (`~/.weflow/keys/`, overridable via
 * WEFLOW_HOME), deliberately decoupled from any single solution store:
 * publishing, registry verification and installation into a fresh store must
 * all resolve the same key material.
 */
export function defaultDevSigningKeyPath(): string {
  return join(
    process.env.WEFLOW_HOME ?? join(homedir(), ".weflow"),
    "keys",
    "dev-signing-key.pem",
  );
}

/**
 * Load an ed25519 signing key pair from `privateKeyPemPath`, generating and
 * persisting one on first use. The public key is written next to the private
 * key with a `.pub` suffix.
 */
export async function generateSigningKey(
  privateKeyPemPath: string,
): Promise<{ keyPair: SigningKeyPair }> {
  if (existsSync(privateKeyPemPath)) {
    const privateKeyPem = await readFile(privateKeyPemPath, "utf8");
    const publicKeyPem = await readFile(`${privateKeyPemPath}.pub`, "utf8");
    return { keyPair: { privateKeyPem, publicKeyPem } };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyPair = {
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  await mkdir(join(privateKeyPemPath, ".."), { recursive: true });
  await writeFile(privateKeyPemPath, keyPair.privateKeyPem, "utf8");
  await writeFile(`${privateKeyPemPath}.pub`, keyPair.publicKeyPem, "utf8");
  return { keyPair };
}

/**
 * Build the solution lock from staged contents and write
 * `solution.lock.json` into the staged directory.
 */
export async function writeSolutionLock(
  stagedDir: string,
  manifestInput: unknown,
): Promise<SolutionLockV1> {
  const descriptor = describeSolution(manifestInput);
  const manifest = descriptor.manifest;
  const resolvedArtifacts = [];
  for (const artifact of manifest.artifacts) {
    const relDir = normalizeRef(artifactRef(artifact));
    const artifactPath = join(stagedDir, relDir);
    if (!existsSync(artifactPath)) {
      throw new Error(`solution_artifact_missing:${artifact.id}:${relDir}`);
    }
    const { digest, size } = await digestPath(artifactPath);
    resolvedArtifacts.push({
      id: artifact.id,
      ref: artifactRef(artifact),
      digest,
      size,
    });
  }
  const lock = parseSolutionLock({
    apiVersion: "weflow.io/v1",
    solutionId: manifest.metadata.id,
    solutionVersion: manifest.metadata.version,
    manifestDigest: descriptor.manifestDigest,
    resolvedArtifacts,
  });
  await writeFile(
    join(stagedDir, "solution.lock.json"),
    JSON.stringify(lock, null, 2),
    "utf8",
  );
  return lock;
}

/** Read a staged/extracted package directory into a descriptor (manifest + optional lock). */
export async function describeStagedSolution(
  dir: string,
): Promise<SolutionDescriptor> {
  const manifestInput = await readManifestFile(dir);
  const descriptor = describeSolution(manifestInput);
  const lockPath = join(dir, "solution.lock.json");
  if (existsSync(lockPath)) {
    const lock = parseSolutionLock(
      JSON.parse(await readFile(lockPath, "utf8")),
    );
    if (lock.manifestDigest !== descriptor.manifestDigest) {
      throw new Error("solution_lock_manifest_digest_mismatch");
    }
    return { ...descriptor, lock, lockDigest: sha256Digest(lock) };
  }
  return descriptor;
}

/** Strict variant: manifest + lock + signature must all be present and consistent. */
export async function describeStagedSolutionPackage(
  dir: string,
): Promise<SolutionPackageDescriptor> {
  const descriptor = await describeStagedSolution(dir);
  if (!descriptor.lock) throw new Error("solution_lock_missing");
  const signaturePath = join(dir, "signature.json");
  if (!existsSync(signaturePath)) throw new Error("solution_signature_missing");
  const signature = solutionSignatureSchema.parse(
    JSON.parse(await readFile(signaturePath, "utf8")),
  );
  return {
    ...(descriptor as SolutionDescriptor & { lock: SolutionLockV1 }),
    signature,
  };
}

/**
 * Sign a descriptor's `manifestDigest:lockDigest` payload with an ed25519
 * private key.
 */
export function signSolutionPackage(
  descriptor: SolutionDescriptor,
  privateKeyPem: string,
  keyId: string,
): SolutionSignature {
  if (!descriptor.lock || !descriptor.lockDigest) {
    throw new Error("solution_lock_required_for_signing");
  }
  const payload = Buffer.from(
    `${descriptor.manifestDigest}:${descriptor.lockDigest}`,
    "utf8",
  );
  return solutionSignatureSchema.parse({
    algorithm: "ed25519",
    keyId,
    signature: cryptoSign(null, payload, privateKeyPem).toString("base64"),
  });
}

export type PackSolutionInput = {
  sourceDir: string;
  outDir: string;
  privateKeyPemPath: string;
  keyId?: string;
};

export type PackSolutionResult = {
  tgzPath: string;
  descriptor: SolutionPackageDescriptor;
};

/**
 * Full publish flow: stage 鈫?lock 鈫?sign 鈫?tgz. The tgz is self-contained
 * and verifiable without the original source tree.
 */
export async function packSolution(
  input: PackSolutionInput,
): Promise<PackSolutionResult> {
  const staged = await stagePackagedSolution(input.sourceDir);
  try {
    const manifestInput = await readManifestFile(input.sourceDir);
    await writeSolutionLock(staged, manifestInput);
    const descriptor = await describeStagedSolution(staged);
    const { keyPair } = await generateSigningKey(input.privateKeyPemPath);
    const signature = signSolutionPackage(
      descriptor,
      keyPair.privateKeyPem,
      input.keyId ?? "weflow-dev",
    );
    await writeFile(
      join(staged, "signature.json"),
      JSON.stringify(signature, null, 2),
      "utf8",
    );
    const fullDescriptor = await describeStagedSolutionPackage(staged);
    const { id, version } = fullDescriptor.manifest.metadata;
    const safeName = `${id}-${version}`.replace(/[^a-zA-Z0-9._-]/g, "-");
    await mkdir(input.outDir, { recursive: true });
    const tgzPath = join(input.outDir, `${safeName}.tgz`);
    await tar.c({ gzip: true, file: tgzPath, cwd: staged, portable: true }, [
      ".",
    ]);
    return { tgzPath, descriptor: fullDescriptor };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

/**
 * Extract a solution tgz into `destDir` (created if needed). Handles both our
 * root-relative layout and npm-style `package/`-prefixed layouts.
 */
export async function extractSolutionTgz(
  tgzPath: string,
  destDir?: string,
): Promise<string> {
  const dest =
    destDir ?? (await mkdtemp(join(tmpdir(), "weflow-solution-pkg-")));
  await mkdir(dest, { recursive: true });
  await tar.x({ file: tgzPath, cwd: dest });
  const packagePrefix = join(dest, "package");
  if (existsSync(packagePrefix)) {
    const entries = await readdir(dest);
    if (entries.length === 1) return packagePrefix;
  }
  return dest;
}

export type InstallSolutionPackageOptions = {
  mode: "development" | "production";
  /** PEM public key that must have signed the package. */
  trustedPublicKeyPem?: string;
};

export type InstallSolutionPackageResult = {
  solutionId: string;
  version: string;
  manifestDigest: string;
  storeDir: string;
};

/**
 * Verify a package (directory or tgz) and install it into the store.
 * Activation is a separate, explicit step.
 */
export async function installSolutionPackage(
  packagePath: string,
  options: InstallSolutionPackageOptions,
): Promise<InstallSolutionPackageResult> {
  const isTgz =
    /\.(tgz|tar\.gz)$/i.test(packagePath) || extname(packagePath) === ".tgz";
  let extractedTo: string | null = null;
  try {
    let packageDir = resolve(packagePath);
    if (isTgz) {
      extractedTo = await mkdtemp(join(tmpdir(), "weflow-solution-pkg-"));
      packageDir = await extractSolutionTgz(packagePath, extractedTo);
    }
    const descriptor = await describeStagedSolutionPackage(packageDir);
    const trustedPublicKeyPem =
      options.trustedPublicKeyPem ??
      (await loadDefaultTrustedKey(options.mode));
    if (!trustedPublicKeyPem) {
      throw new Error(
        options.mode === "production"
          ? "trusted_public_key_required_for_production_install"
          : "trusted_public_key_required_for_install",
      );
    }
    if (
      !verifySolutionSignature(
        descriptor,
        descriptor.signature,
        trustedPublicKeyPem,
      )
    ) {
      throw new Error("solution_signature_invalid");
    }
    const storeDir = await installSolutionToStore(
      packageDir,
      descriptor.manifest.metadata.id,
      descriptor.manifest.metadata.version,
      descriptor.manifestDigest,
    );
    return {
      solutionId: descriptor.manifest.metadata.id,
      version: descriptor.manifest.metadata.version,
      manifestDigest: descriptor.manifestDigest,
      storeDir,
    };
  } finally {
    if (extractedTo) await rm(extractedTo, { recursive: true, force: true });
  }
}

async function loadDefaultTrustedKey(
  mode: "development" | "production",
): Promise<string | undefined> {
  const envKey = process.env.WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY;
  if (envKey) {
    if (envKey.includes("BEGIN")) return envKey;
    if (existsSync(envKey)) return readFile(envKey, "utf8");
  }
  if (mode !== "development") return undefined;
  const devPub = `${defaultDevSigningKeyPath()}.pub`;
  if (existsSync(devPub)) return readFile(devPub, "utf8");
  return undefined;
}
