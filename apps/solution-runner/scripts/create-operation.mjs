import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { solutionPayloadDigest } from "@weflow/solution-sdk";

const fixtureDir = process.env.SOLUTION_DIR
  ? resolve(process.env.SOLUTION_DIR)
  : null;

const coreApiUrl = process.env.CORE_API_URL;
const adminToken = process.env.ADMIN_TOKEN;
const idempotencyKey =
  process.env.IDEMPOTENCY_KEY ?? `dev-install-${Date.now()}`;

if (!coreApiUrl || !adminToken) {
  console.error("CORE_API_URL and ADMIN_TOKEN environment variables are required");
  process.exit(1);
}
if (!fixtureDir) {
  console.error(
    "SOLUTION_DIR environment variable is required: path to a solution dir containing solution.manifest.json / solution.lock.json / signature.json",
  );
  process.exit(1);
}

const manifest = JSON.parse(
  await readFile(resolve(fixtureDir, "solution.manifest.json"), "utf8"),
);
const lock = JSON.parse(
  await readFile(resolve(fixtureDir, "solution.lock.json"), "utf8"),
);
const signature = JSON.parse(
  await readFile(resolve(fixtureDir, "signature.json"), "utf8"),
);

const planDigest = solutionPayloadDigest(manifest, lock);
const body = {
  solutionId: manifest.metadata.id,
  type: "install",
  idempotencyKey,
  solutionVersion: manifest.metadata.version,
  planDigest,
  manifest,
  lock,
  signature,
};

const response = await fetch(`${coreApiUrl.replace(/\/$/, "")}/api/v1/admin/solution-operations`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const text = await response.text();
if (!response.ok) {
  console.error(`create operation failed: ${response.status} ${text}`);
  process.exit(1);
}

console.log(text);
