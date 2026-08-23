import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultDevSigningKeyPath,
  generateSigningKey,
} from "../infrastructure/solutions/solution-pack.js";
import {
  exportPublicKey,
  importSigningKey,
  listSigningKeys,
} from "../infrastructure/solutions/solution-keys.js";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "weflow-keys-"));
  previousHome = process.env.WEFLOW_HOME;
  process.env.WEFLOW_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.WEFLOW_HOME;
  else process.env.WEFLOW_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("signing key management", () => {
  it("lists local keys with fingerprints", async () => {
    await generateSigningKey(join(home, "keys", "dev-signing-key.pem"));
    await generateSigningKey(join(home, "keys", "release-2026.pem"));

    const keys = await listSigningKeys();
    expect(keys.map((item) => item.name).sort()).toEqual([
      "dev-signing-key",
      "release-2026",
    ]);
    expect(
      keys.every(
        (item) =>
          item.fingerprint.startsWith("sha256:") &&
          item.fingerprint.length === "sha256:".length + 64,
      ),
    ).toBe(true);
  });

  it("imports a foreign private key and derives its public key", async () => {
    const foreignDir = join(home, "foreign");
    await mkdir(foreignDir, { recursive: true });
    const { keyPair } = await generateSigningKey(
      join(foreignDir, "incoming.pem"),
    );

    const imported = await importSigningKey(join(foreignDir, "incoming.pem"));
    expect(imported.name).toBe("incoming");
    expect(imported.publicKeyPem).toBe(keyPair.publicKeyPem);

    // The imported pair now participates in the local key list.
    const keys = await listSigningKeys();
    expect(keys.map((item) => item.name)).toContain("incoming");
  });

  it("rejects importing a file that is not a private key", async () => {
    const bogus = join(home, "bogus.pem");
    await writeFile(bogus, "not a key", "utf8");
    await expect(importSigningKey(bogus)).rejects.toThrow(
      "signing_key_invalid",
    );
  });

  it("exports the public key for the default or a named key", async () => {
    const { keyPair } = await generateSigningKey(defaultDevSigningKeyPath());
    const exported = await exportPublicKey();
    expect(exported.publicKeyPem).toBe(keyPair.publicKeyPem);
    expect(exported.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
