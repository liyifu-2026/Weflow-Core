#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  planSolution,
  solutionPayloadDigest,
  validateSolutionLock,
  validateSolutionManifest,
  verifyDocumentSignature,
} from "@weflow/solution-sdk";
import type { PlannerInput } from "@weflow/solution-sdk";

type ParsedArgs = Record<string, string>;

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      out[key] = value;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as Record<
    string,
    unknown
  >;
}

function requireCoreArgs(args: ParsedArgs): {
  coreUrl: string;
  adminToken: string;
} {
  const coreUrl = args["core-url"];
  const adminToken = args["admin-token"];
  if (!coreUrl || !adminToken) {
    throw new Error(
      "usage: --core-url <url> --admin-token <token> are required",
    );
  }
  return { coreUrl: coreUrl.replace(/\/$/, ""), adminToken };
}

async function requestJson(
  coreUrl: string,
  adminToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${coreUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function createOperation(
  args: ParsedArgs,
  solutionId: string,
  type: string,
): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const body = {
    solutionId,
    type,
    idempotencyKey: args["idempotency-key"] ?? `weflowctl-${type}-${Date.now()}`,
  };
  const result = (await requestJson(
    coreUrl,
    adminToken,
    "/api/v1/admin/solution-operations",
    { method: "POST", body: JSON.stringify(body) },
  )) as { operationId?: string };
  if (!result.operationId) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ operationId: result.operationId }, null, 2));
}

async function status(args: ParsedArgs, solutionId: string): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const data = (await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}`,
  )) as {
    installation?: unknown;
    recentOperations?: unknown[];
  };
  console.log(
    JSON.stringify(
      {
        solutionId,
        installation: data.installation ?? null,
        recentOperations: data.recentOperations ?? [],
      },
      null,
      2,
    ),
  );
}

async function verify(args: ParsedArgs): Promise<void> {
  const manifestPath = args.manifest;
  const lockPath = args.lock;
  const signaturePath = args.signature;
  const publicKeyPath = args["public-key"];
  if (!manifestPath || !lockPath || !signaturePath || !publicKeyPath) {
    console.error(
      "usage: weflowctl solution verify --manifest <path> --lock <path> --signature <path> --public-key <path>",
    );
    process.exitCode = 1;
    return;
  }
  const manifest = await readJson(manifestPath);
  const lock = await readJson(lockPath);
  const signature = await readJson(signaturePath);
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  const issues: string[] = [];
  if (!manifestResult.ok) {
    for (const issue of manifestResult.issues) {
      issues.push(`manifest ${issue.path}: ${issue.message}`);
    }
  }
  if (!lockResult.ok) {
    for (const issue of lockResult.issues) {
      issues.push(`lock ${issue.path}: ${issue.message}`);
    }
  }
  if (issues.length > 0) {
    console.error(JSON.stringify({ ok: false, issues }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!manifestResult.ok || !lockResult.ok) {
    process.exitCode = 1;
    return;
  }
  const publicKeyPem = await readFile(resolve(publicKeyPath), "utf8");
  const signatureValid = verifyDocumentSignature(
    manifest,
    signature as unknown as Parameters<typeof verifyDocumentSignature>[1],
    publicKeyPem,
  );
  if (!signatureValid) {
    console.error(
      JSON.stringify({ ok: false, issues: ["signature verification failed"] }, null, 2),
    );
    process.exitCode = 1;
    return;
  }
  const digest = solutionPayloadDigest(manifestResult.value, lockResult.value);

  const artifactIssues: string[] = [];
  const lockDir = resolve(lockPath, "..");
  for (const artifact of lockResult.value.artifacts) {
    const registry = artifact.registry ?? "file";
    if (registry !== "file") {
      artifactIssues.push(`artifact ${artifact.id}: unsupported registry ${registry}`);
      continue;
    }
    const candidate = resolve(lockDir, artifact.ref);
    const rel = relative(lockDir, candidate);
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.split(sep).includes("..")
    ) {
      artifactIssues.push(`artifact ${artifact.id}: path escapes lock directory`);
      continue;
    }
    const content = await readFile(candidate);
    const actualDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualDigest !== artifact.digest) {
      artifactIssues.push(
        `artifact ${artifact.id}: digest mismatch expected ${artifact.digest} got ${actualDigest}`,
      );
    }
  }
  if (artifactIssues.length > 0) {
    console.error(JSON.stringify({ ok: false, issues: artifactIssues }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        solutionId: manifestResult.value.metadata.id,
        solutionVersion: manifestResult.value.metadata.version,
        payloadDigest: digest,
        signatureValid: true,
        artifactsVerified: lockResult.value.artifacts.length,
      },
      null,
      2,
    ),
  );
}

async function validate(manifestPath: string, lockPath: string): Promise<void> {
  const manifest = await readJson(manifestPath);
  const lock = await readJson(lockPath);
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          manifestIssues: manifestResult.ok ? [] : manifestResult.issues,
          lockIssues: lockResult.ok ? [] : lockResult.issues,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const digest = solutionPayloadDigest(manifestResult.value, lockResult.value);
  console.log(
    JSON.stringify(
      {
        ok: true,
        solutionId: manifestResult.value.metadata.id,
        solutionVersion: manifestResult.value.metadata.version,
        payloadDigest: digest,
      },
      null,
      2,
    ),
  );
}

async function plan(args: ParsedArgs): Promise<void> {
  const manifestPath = args.manifest;
  const lockPath = args.lock;
  const platformVersion = args.platform;
  if (!manifestPath || !lockPath || !platformVersion) {
    console.error(
      "usage: weflowctl solution plan --manifest <path> --lock <path> --platform <version> [--plugin-sdk <version>]",
    );
    process.exitCode = 1;
    return;
  }
  const manifest = await readJson(manifestPath);
  const lock = await readJson(lockPath);
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    console.error("invalid solution manifest or lock");
    process.exitCode = 1;
    return;
  }

  const input: PlannerInput = {
    descriptor: { manifest: manifestResult.value, lock: lockResult.value },
    platformVersion,
    ...(args["plugin-sdk"] === undefined
      ? {}
      : { pluginSdkVersion: args["plugin-sdk"] }),
    installedSolutions: [],
    capabilityCatalog: [],
    artifactCatalog: [],
    secretInventory: { configured: [] },
    runtimeState: { processes: [], available: true },
  };
  console.log(JSON.stringify(planSolution(input), null, 2));
}

async function install(args: ParsedArgs): Promise<void> {
  const manifestPath = args.manifest;
  const lockPath = args.lock;
  const signaturePath = args.signature;
  const coreUrl = args["core-url"];
  const adminToken = args["admin-token"];
  if (!manifestPath || !lockPath || !signaturePath || !coreUrl || !adminToken) {
    console.error(
      "usage: weflowctl solution install --manifest <path> --lock <path> --signature <path> --core-url <url> --admin-token <token> [--idempotency-key <key>]",
    );
    process.exitCode = 1;
    return;
  }
  const manifest = await readJson(manifestPath);
  const lock = await readJson(lockPath);
  const signature = await readJson(signaturePath);
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    console.error("invalid solution manifest or lock");
    process.exitCode = 1;
    return;
  }
  const planDigest = solutionPayloadDigest(
    manifestResult.value,
    lockResult.value,
  );
  const body = {
    solutionId: manifestResult.value.metadata.id,
    type: "install",
    idempotencyKey:
      args["idempotency-key"] ?? `weflowctl-install-${Date.now()}`,
    solutionVersion: manifestResult.value.metadata.version,
    planDigest,
    manifest,
    lock,
    signature,
  };
  const response = await fetch(
    `${coreUrl.replace(/\/$/, "")}/api/v1/admin/solution-operations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    console.error(`install failed: ${response.status} ${text}`);
    process.exitCode = 1;
    return;
  }
  console.log(text);
}

async function secrets(args: ParsedArgs, solutionId: string): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const data = (await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}/secrets`,
  )) as { slots?: unknown };
  console.log(JSON.stringify({ solutionId, slots: data.slots ?? [] }, null, 2));
}

async function setSecret(
  args: ParsedArgs,
  solutionId: string,
  slotName: string,
): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const refType = args.type;
  const refValue = args.ref;
  if (refType !== "env" && refType !== "file") {
    console.error("usage: --type env|file and --ref <value> are required");
    process.exitCode = 1;
    return;
  }
  if (!refValue) {
    console.error("usage: --type env|file and --ref <value> are required");
    process.exitCode = 1;
    return;
  }
  await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}/secrets/${encodeURIComponent(slotName)}`,
    {
      method: "PUT",
      body: JSON.stringify({ refType, refValue }),
    },
  );
  console.log(
    JSON.stringify(
      { solutionId, slotName, refType, refValue, configured: true },
      null,
      2,
    ),
  );
}

async function unsetSecret(
  args: ParsedArgs,
  solutionId: string,
  slotName: string,
): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}/secrets/${encodeURIComponent(slotName)}`,
    { method: "DELETE" },
  );
  console.log(
    JSON.stringify({ solutionId, slotName, configured: false }, null, 2),
  );
}

async function upgrade(args: ParsedArgs): Promise<void> {
  const manifestPath = args.manifest;
  const lockPath = args.lock;
  const signaturePath = args.signature;
  const { coreUrl, adminToken } = requireCoreArgs(args);
  if (!manifestPath || !lockPath || !signaturePath) {
    console.error(
      "usage: weflowctl solution upgrade --manifest <path> --lock <path> --signature <path> --core-url <url> --admin-token <token> [--idempotency-key <key>]",
    );
    process.exitCode = 1;
    return;
  }
  const manifest = await readJson(manifestPath);
  const lock = await readJson(lockPath);
  const signature = await readJson(signaturePath);
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    console.error("invalid solution manifest or lock");
    process.exitCode = 1;
    return;
  }
  const planDigest = solutionPayloadDigest(
    manifestResult.value,
    lockResult.value,
  );
  const body = {
    solutionId: manifestResult.value.metadata.id,
    type: "upgrade",
    idempotencyKey:
      args["idempotency-key"] ?? `weflowctl-upgrade-${Date.now()}`,
    solutionVersion: manifestResult.value.metadata.version,
    planDigest,
    manifest,
    lock,
    signature,
  };
  const result = (await requestJson(
    coreUrl,
    adminToken,
    "/api/v1/admin/solution-operations",
    { method: "POST", body: JSON.stringify(body) },
  )) as { operationId?: string };
  if (!result.operationId) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ operationId: result.operationId }, null, 2));
}

async function health(args: ParsedArgs, solutionId: string): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const data = (await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}`,
  )) as { installation?: { healthState?: string } };
  console.log(
    JSON.stringify(
      { solutionId, healthState: data.installation?.healthState ?? "unknown" },
      null,
      2,
    ),
  );
}

async function logs(args: ParsedArgs, operationId: string): Promise<void> {
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const data = await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solution-operations/${encodeURIComponent(operationId)}`,
  );
  console.log(JSON.stringify({ operationId, operation: data }, null, 2));
}

async function diff(args: ParsedArgs, solutionId: string): Promise<void> {
  const manifestPath = args.manifest;
  const lockPath = args.lock;
  if (!manifestPath || !lockPath) {
    console.error(
      "usage: weflowctl solution diff <solution-id> --manifest <path> --lock <path> [--core-url <url> --admin-token <token>]",
    );
    process.exitCode = 1;
    return;
  }
  const manifest = await readJson(manifestPath);
  const lock = await readJson(lockPath);
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    console.error("invalid solution manifest or lock");
    process.exitCode = 1;
    return;
  }
  const { coreUrl, adminToken } = requireCoreArgs(args);
  const remote = (await requestJson(
    coreUrl,
    adminToken,
    `/api/v1/admin/solutions/${encodeURIComponent(solutionId)}`,
  )) as { installation?: { version?: string } };
  const digest = solutionPayloadDigest(manifestResult.value, lockResult.value);
  console.log(
    JSON.stringify(
      {
        solutionId,
        localVersion: manifestResult.value.metadata.version,
        installedVersion: remote.installation?.version ?? null,
        payloadDigest: digest,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  if (command === "solution" && subcommand === "validate") {
    if (!args.manifest || !args.lock) {
      console.error(
        "usage: weflowctl solution validate --manifest <path> --lock <path>",
      );
      process.exitCode = 1;
      return;
    }
    await validate(args.manifest, args.lock);
    return;
  }
  if (command === "solution" && subcommand === "plan") {
    await plan(args);
    return;
  }
  if (command === "solution" && subcommand === "install") {
    await install(args);
    return;
  }
  if (command === "solution" && subcommand === "verify") {
    await verify(args);
    return;
  }
  if (command === "solution" && subcommand === "upgrade") {
    await upgrade(args);
    return;
  }
  if (command === "solution" && subcommand === "rollback") {
    const solutionId = positional[0];
    if (!solutionId) {
      console.error(
        "usage: weflowctl solution rollback <solution-id> [--core-url <url> --admin-token <token>]",
      );
      process.exitCode = 1;
      return;
    }
    await createOperation(args, solutionId, "rollback");
    return;
  }
  if (command === "solution" && subcommand === "health") {
    const solutionId = positional[0];
    if (!solutionId) {
      console.error(
        "usage: weflowctl solution health <solution-id> [--core-url <url> --admin-token <token>]",
      );
      process.exitCode = 1;
      return;
    }
    await health(args, solutionId);
    return;
  }
  if (command === "solution" && subcommand === "logs") {
    const operationId = positional[0];
    if (!operationId) {
      console.error(
        "usage: weflowctl solution logs <operation-id> [--core-url <url> --admin-token <token>]",
      );
      process.exitCode = 1;
      return;
    }
    await logs(args, operationId);
    return;
  }
  if (command === "solution" && subcommand === "diff") {
    const solutionId = positional[0];
    if (!solutionId) {
      console.error(
        "usage: weflowctl solution diff <solution-id> --manifest <path> --lock <path> [--core-url <url> --admin-token <token>]",
      );
      process.exitCode = 1;
      return;
    }
    await diff(args, solutionId);
    return;
  }
  if (command === "solution" && subcommand === "status") {
    const solutionId = positional[0];
    if (!solutionId) {
      console.error("usage: weflowctl solution status <solution-id> [--core-url <url> --admin-token <token>]");
      process.exitCode = 1;
      return;
    }
    await status(args, solutionId);
    return;
  }
  if (
    command === "solution" &&
    (subcommand === "activate" ||
      subcommand === "disable" ||
      subcommand === "uninstall")
  ) {
    const solutionId = positional[0];
    if (!solutionId) {
      console.error(
        `usage: weflowctl solution ${subcommand} <solution-id> [--core-url <url> --admin-token <token>]`,
      );
      process.exitCode = 1;
      return;
    }
    await createOperation(args, solutionId, subcommand);
    return;
  }
  if (command === "solution" && subcommand === "secrets") {
    const solutionId = positional[0];
    if (!solutionId) {
      console.error(
        "usage: weflowctl solution secrets <solution-id> [--core-url <url> --admin-token <token>]",
      );
      process.exitCode = 1;
      return;
    }
    await secrets(args, solutionId);
    return;
  }
  if (command === "solution" && subcommand === "secret") {
    const action = positional[0];
    const solutionId = positional[1];
    if (action === "set" && solutionId) {
      const slotName = positional[2];
      if (!slotName) {
        console.error(
          "usage: weflowctl solution secret set <solution-id> <slot-name> --type env|file --ref VALUE [--core-url <url> --admin-token <token>]",
        );
        process.exitCode = 1;
        return;
      }
      await setSecret(args, solutionId, slotName);
      return;
    }
    if (action === "unset" && solutionId) {
      const slotName = positional[2];
      if (!slotName) {
        console.error(
          "usage: weflowctl solution secret unset <solution-id> <slot-name> [--core-url <url> --admin-token <token>]",
        );
        process.exitCode = 1;
        return;
      }
      await unsetSecret(args, solutionId, slotName);
      return;
    }
  }
  console.error(
    "usage: weflowctl solution <validate|plan|install|verify|status|activate|disable|uninstall|upgrade|rollback|health|logs|diff|secrets|secret> [options]",
  );
  process.exitCode = 1;
}

await main();
