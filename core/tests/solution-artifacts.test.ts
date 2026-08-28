/**
 * SDK 浜х墿鏍￠獙鍞竴瀹炵幇鐨勫洖褰掓祴璇曘€? *
 * 瑕嗙洊锛氭伓鎰?ref锛堢浉瀵归€冮€搞€佸弽鏂滄潬閫冮€搞€佺粷瀵硅矾寰勩€佺洏绗﹁矾寰勩€乫ile: 鍓嶇紑锛夈€? * digest/size 涓嶅尮閰嶃€佺洰褰曚骇鐗╃‘瀹氭€у搱甯岋紝浠ュ強 assertSolutionArtifacts 鐨? * 楂樺眰闂ㄧ閿欒鐮併€? */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSolutionArtifacts,
  digestArtifactPath,
  verifyArtifactRef,
  type SolutionLockV1,
} from "@weflow-leaif/solution-sdk";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "weflow-artifacts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("verifyArtifactRef", () => {
  const cases: Array<[string, string, boolean]> = [
    ["plugins/demo", "ok", true],
    ["./plugins/demo", "ok", true],
    ["file:plugins/demo", "ok", true],
    ["plugins\\demo", "ok", true],
    ["../secret", "escape", false],
    ["..\\..\\secret", "escape", false],
    ["plugins/../../secret", "escape", false],
    ["/etc/passwd", "absolute", false],
    ["C:\\Windows\\system32", "drive", false],
    ["C:/Windows", "drive", false],
    ["", "empty", false],
    ["a//b", "segment", false],
  ];

  for (const [ref, label, ok] of cases) {
    it(`${ok ? "accepts" : "rejects"} ${label}: ${JSON.stringify(ref)}`, () => {
      const result = verifyArtifactRef(ref, dir);
      expect(result.ok).toBe(ok);
      if (result.ok) {
        expect(result.path.startsWith(dir)).toBe(true);
      }
    });
  }

  it("resolves to a path inside the lock dir", () => {
    const result = verifyArtifactRef("plugins/demo/dist/plugin.js", dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(dir, "plugins", "demo", "dist", "plugin.js"));
    }
  });
});

describe("digestArtifactPath", () => {
  it("hashes a file deterministically", async () => {
    const file = join(dir, "artifact.bin");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const first = await digestArtifactPath(file);
    const second = await digestArtifactPath(file);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.size).toBe(3);
    expect(first.digest).toBe(second.digest);
  });

  it("hashes a directory with sorted walk (order-independent)", async () => {
    const sub = join(dir, "pkg");
    await mkdir(join(sub, "b"), { recursive: true });
    await writeFile(join(sub, "a.txt"), "A");
    await writeFile(join(sub, "b", "c.txt"), "C");
    const first = await digestArtifactPath(sub);
    const second = await digestArtifactPath(sub);
    expect(first.digest).toBe(second.digest);
    expect(first.size).toBe(2);
  });

  it("changes when content changes", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "v1");
    const before = await digestArtifactPath(file);
    await writeFile(file, "v2");
    const after = await digestArtifactPath(file);
    expect(before.digest).not.toBe(after.digest);
  });
});

describe("assertSolutionArtifacts", () => {
  function lockWith(entries: SolutionLockV1["resolvedArtifacts"]): {
    lock: SolutionLockV1;
  } {
    return {
      lock: {
        apiVersion: "weflow.io/v1",
        solutionId: "weflow.demo",
        solutionVersion: "1.0.0",
        manifestDigest: "sha256:" + "0".repeat(64),
        resolvedArtifacts: entries,
      },
    };
  }

  it("passes when digests and sizes match", async () => {
    const pluginsDir = join(dir, "plugins", "demo");
    await mkdir(pluginsDir, { recursive: true });
    const content = Buffer.from("plugin-bundle");
    await writeFile(join(pluginsDir, "plugin.js"), content);
    const { digest, size } = await digestArtifactPath(pluginsDir);
    const verified = await assertSolutionArtifacts(
      lockWith([{ id: "demo", ref: "plugins/demo", digest, size }]),
      dir,
    );
    expect(verified).toHaveLength(1);
    expect(verified[0]?.id).toBe("demo");
  });

  it("fails on digest mismatch", async () => {
    const pluginsDir = join(dir, "plugins", "tampered");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, "plugin.js"), "actual-content");
    const goodDigest = `sha256:${"a".repeat(64)}`;
    await expect(
      assertSolutionArtifacts(
        lockWith([
          { id: "demo", ref: "plugins/tampered", digest: goodDigest, size: 14 },
        ]),
        dir,
      ),
    ).rejects.toThrow("solution_artifact_digest_mismatch:demo");
  });

  it("fails on size mismatch even when digest matches", async () => {
    const pluginsDir = join(dir, "plugins", "sized");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, "plugin.js"), "12345");
    const { digest } = await digestArtifactPath(pluginsDir);
    await expect(
      assertSolutionArtifacts(
        lockWith([{ id: "demo", ref: "plugins/sized", digest, size: 999 }]),
        dir,
      ),
    ).rejects.toThrow("solution_artifact_size_mismatch:demo");
  });

  it("fails on missing artifact", async () => {
    await expect(
      assertSolutionArtifacts(
        lockWith([
          {
            id: "ghost",
            ref: "plugins/ghost",
            digest: `sha256:${"b".repeat(64)}`,
            size: 1,
          },
        ]),
        dir,
      ),
    ).rejects.toThrow("solution_artifact_missing:ghost");
  });

  it("fails closed on malicious refs before touching the filesystem", async () => {
    for (const ref of ["../../secret", "..\\..\\secret", "/etc/passwd", "C:\\x"]) {
      await expect(
        assertSolutionArtifacts(
          lockWith([
            {
              id: "evil",
              ref,
              digest: `sha256:${"c".repeat(64)}`,
              size: 0,
            },
          ]),
          dir,
        ),
      ).rejects.toThrow(/solution_artifact_path_escape:evil/);
    }
  });
});
