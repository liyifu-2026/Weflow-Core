/**
 * Signing key management helpers for the CLI.
 *
 * Keys live in `~/.weflow/keys/` (see defaultDevSigningKeyPath). A key pair is
 * stored as `<name>.pem` (PKCS8 private) plus `<name>.pem.pub` (SPKI public).
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { defaultDevSigningKeyPath } from "./solution-pack.js";

export type SigningKeyInfo = {
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  fingerprint: string;
};

function keysDir(): string {
  return join(defaultDevSigningKeyPath(), "..");
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  return `sha256:${createHash("sha256").update(publicKeyPem).digest("hex")}`;
}

/** List every local signing key pair with its public key fingerprint. */
export async function listSigningKeys(): Promise<SigningKeyInfo[]> {
  const dir = keysDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const infos: SigningKeyInfo[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".pem") ||
      entry.name.endsWith(".pem.pub")
    ) {
      continue;
    }
    const name = entry.name.replace(/\.pem$/, "");
    const privateKeyPath = join(dir, entry.name);
    const publicKeyPath = `${privateKeyPath}.pub`;
    if (!existsSync(publicKeyPath)) continue;
    try {
      // Only list files that are actually private keys.
      createPrivateKey(await readFile(privateKeyPath, "utf8"));
    } catch {
      continue;
    }
    const publicKeyPem = await readFile(publicKeyPath, "utf8");
    infos.push({
      name,
      privateKeyPath,
      publicKeyPath,
      fingerprint: fingerprintPublicKey(publicKeyPem),
    });
  }
  return infos.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Import a foreign PKCS8 private key into the local key store and derive +
 * persist its public key. The key name defaults to the source file name.
 */
export async function importSigningKey(
  sourcePath: string,
  options: { name?: string } = {},
): Promise<{
  name: string;
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyPem: string;
}> {
  let privateKeyPem: string;
  try {
    privateKeyPem = await readFile(sourcePath, "utf8");
    createPrivateKey(privateKeyPem);
  } catch {
    throw new Error(`signing_key_invalid:${sourcePath}`);
  }
  const publicKey = createPublicKey(privateKeyPem);
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const baseName =
    options.name ??
    (sourcePath.split(/[\\/]/).pop() ?? "imported-key").replace(/\.pem$/, "");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = keysDir();
  await mkdir(dir, { recursive: true });
  const privateKeyPath = join(dir, `${baseName}.pem`);
  const publicKeyPath = `${privateKeyPath}.pub`;
  await copyFile(sourcePath, privateKeyPath);
  await writeFile(publicKeyPath, publicKeyPem, "utf8");
  return { name: baseName, privateKeyPath, publicKeyPath, publicKeyPem };
}

/** Read the public key of the default signing pair. */
export async function exportPublicKey(): Promise<{
  publicKeyPem: string;
  fingerprint: string;
}> {
  const publicKeyPath = `${defaultDevSigningKeyPath()}.pub`;
  if (!existsSync(publicKeyPath)) {
    throw new Error(`signing_key_not_found:${publicKeyPath}`);
  }
  const publicKeyPem = await readFile(publicKeyPath, "utf8");
  return { publicKeyPem, fingerprint: fingerprintPublicKey(publicKeyPem) };
}
