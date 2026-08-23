/**
 * Solution Registry HTTP routes.
 *
 * Read endpoints serve the local registry layout; publish verifies the
 * uploaded package (manifest+lock+signature triple, trusted key) before it is
 * accepted. Publishing is fail-closed: without a configured publish token the
 * route rejects every write.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  defaultDevSigningKeyPath,
  describeStagedSolutionPackage,
  extractSolutionTgz,
} from "./solution-pack.js";
import { verifySolutionSignature } from "@weflow/solution-sdk";
import {
  listRegistrySolutions,
  putRegistryPackage,
  readRegistryEntry,
  readRegistryIndex,
  registryTarballPath,
} from "./solution-registry.js";

export type SolutionRegistryRouteOptions = {
  root: string;
  /** Required bearer token for PUT; publishing is disabled when absent. */
  publishToken?: string | undefined;
  /** Optional read token. When configured, every GET requires it. */
  readToken?: string | undefined;
  /** PEM public key packages must verify against (defaults to dev key). */
  trustedPublicKeyPem?: string | undefined;
  /** Upload size cap for publish (bytes); defaults to 256 MiB. */
  bodyLimit?: number | undefined;
};

export function registerSolutionRegistryRoutes(
  app: FastifyInstance,
  options: SolutionRegistryRouteOptions,
): void {
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: options.bodyLimit ?? 256 * 1024 * 1024 },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get("/v1/solutions", async (request, reply) => {
    if (!isAuthorizedRead(request.headers.authorization, options.readToken)) {
      return reply.code(401).send({ error: "registry_read_unauthorized" });
    }
    const solutionIds = await listRegistrySolutions(options.root);
    const solutions = [];
    for (const solutionId of solutionIds) {
      const index = await readRegistryIndex(options.root, solutionId);
      solutions.push({
        solutionId,
        versionCount: index?.versions.length ?? 0,
      });
    }
    return { solutions };
  });

  app.get("/v1/solutions/:solutionId", async (request, reply) => {
    if (!isAuthorizedRead(request.headers.authorization, options.readToken)) {
      return reply.code(401).send({ error: "registry_read_unauthorized" });
    }
    const { solutionId } = request.params as { solutionId: string };
    const index = await readRegistryIndex(options.root, solutionId);
    if (!index) {
      return reply
        .code(404)
        .send({ error: `registry_solution_not_found:${solutionId}` });
    }
    return index;
  });

  app.get("/v1/solutions/:solutionId/:ref", async (request, reply) => {
    if (!isAuthorizedRead(request.headers.authorization, options.readToken)) {
      return reply.code(401).send({ error: "registry_read_unauthorized" });
    }
    const { solutionId, ref } = request.params as {
      solutionId: string;
      ref: string;
    };
    if (ref.endsWith(".tgz")) {
      const version = ref.replace(/\.tgz$/, "");
      const entry = await readRegistryEntry(options.root, solutionId, version);
      if (!entry) {
        return reply.code(404).send({
          error: `registry_version_not_found:${solutionId}:${version}`,
        });
      }
      const tarball = registryTarballPath(options.root, solutionId, version);
      reply.header("content-type", "application/gzip");
      reply.header("content-length", entry.size);
      return await reply.send(await readFile(tarball));
    }
    const entry = await readRegistryEntry(options.root, solutionId, ref);
    if (!entry) {
      return reply.code(404).send({
        error: `registry_version_not_found:${solutionId}:${ref}`,
      });
    }
    return entry;
  });

  app.put("/v1/solutions/:solutionId/:version", async (request, reply) => {
    const { solutionId, version } = request.params as {
      solutionId: string;
      version: string;
    };
    if (!options.publishToken) {
      return reply.code(403).send({ error: "registry_publish_disabled" });
    }
    const auth = request.headers.authorization ?? "";
    if (auth !== `Bearer ${options.publishToken}`) {
      return reply.code(401).send({ error: "registry_publish_unauthorized" });
    }
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply
        .code(400)
        .send({ error: "registry_body_must_be_octet_stream" });
    }
    const staging = await mkdtemp(join(tmpdir(), "weflow-registry-put-"));
    try {
      const uploadPath = join(staging, "upload.tgz");
      await writeFile(uploadPath, body);
      const extracted = await extractSolutionTgz(
        uploadPath,
        join(staging, "pkg"),
      );
      const descriptor = await describeStagedSolutionPackage(extracted);
      const trustedPublicKeyPem =
        options.trustedPublicKeyPem ?? (await loadTrustedKey());
      if (
        !trustedPublicKeyPem ||
        !verifySolutionSignature(
          descriptor,
          descriptor.signature,
          trustedPublicKeyPem,
        )
      ) {
        return await reply
          .code(400)
          .send({ error: "solution_signature_invalid" });
      }
      await mkdir(join(options.root, solutionId), { recursive: true });
      const stagedTarball = join(staging, "verified.tgz");
      await copyFile(uploadPath, stagedTarball);
      let entry;
      try {
        entry = await putRegistryPackage({
          root: options.root,
          expectedSolutionId: solutionId,
          expectedVersion: version,
          tgzSource: stagedTarball,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return await reply.code(400).send({ error: message });
      }
      return await reply.code(201).send(entry);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

function isAuthorizedRead(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  if (!authorization?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const target = Buffer.from(expected, "utf8");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function loadTrustedKey(): Promise<string | undefined> {
  const envKey = process.env.WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY;
  if (envKey) {
    if (envKey.includes("BEGIN")) return Promise.resolve(envKey);
    return readFile(envKey, "utf8").catch(() => undefined);
  }
  const devPub = `${defaultDevSigningKeyPath()}.pub`;
  if (!existsSync(devPub)) return Promise.resolve(undefined);
  return readFile(devPub, "utf8");
}
