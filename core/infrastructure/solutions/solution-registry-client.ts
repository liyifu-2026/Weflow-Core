/**
 * HTTP client for the Solution Registry.
 *
 * Thin, dependency-free wrapper over fetch with stable error codes so CLI and
 * scheduler callers can surface consistent failures.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RegistryFetchOptions = {
  fetchImpl?: typeof globalThis.fetch;
  /** Bearer token for read endpoints (optional; required when the registry enables read auth). */
  token?: string | undefined;
};

export type RegistryPublishOptions = RegistryFetchOptions & {
  /** Bearer token for the publish endpoint. */
  token?: string | undefined;
};

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === "string") return body.error;
  } catch {
    // fall through to status-only error
  }
  return `registry_http_error:${String(response.status)}`;
}

export async function fetchRegistryVersions(
  baseUrl: string,
  solutionId: string,
  options: RegistryFetchOptions = {},
): Promise<string[]> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await doFetch(
    `${baseUrl.replace(/\/$/, "")}/v1/solutions/${encodeURIComponent(solutionId)}`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const index = (await response.json()) as {
    versions?: Array<{ version: string }>;
  };
  return (index.versions ?? [])
    .map((item) => item.version)
    .sort((left, right) => left.localeCompare(right));
}

export type RegistrySearchResult = {
  solutionId: string;
  versionCount: number;
};

/** List registry entries whose id contains the keyword (case-insensitive). */
export async function searchRegistry(
  baseUrl: string,
  keyword: string,
  options: RegistryFetchOptions = {},
): Promise<RegistrySearchResult[]> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/solutions`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as {
    solutions?: RegistrySearchResult[];
  };
  const needle = keyword.toLowerCase();
  return (body.solutions ?? []).filter((item) =>
    item.solutionId.toLowerCase().includes(needle),
  );
}

export async function downloadSolutionTarball(
  baseUrl: string,
  solutionId: string,
  version: string,
  destDir: string,
  options: RegistryFetchOptions = {},
): Promise<{ tgzPath: string }> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await doFetch(
    `${baseUrl.replace(/\/$/, "")}/v1/solutions/${encodeURIComponent(solutionId)}/${encodeURIComponent(version)}.tgz`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(destDir, { recursive: true });
  const tgzPath = join(destDir, `${solutionId}-${version}.tgz`);
  await writeFile(tgzPath, bytes);
  return { tgzPath };
}

export async function publishSolutionTarball(
  baseUrl: string,
  tgzPath: string,
  options: RegistryPublishOptions,
): Promise<{ version: string; [key: string]: unknown }> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const match =
    /-([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\.tgz$/.exec(
      tgzPath,
    );
  if (!match?.[1]) {
    throw new Error(`registry_publish_name_invalid:${tgzPath}`);
  }
  const version = match[1];
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(tgzPath);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await doFetch(
    `${baseUrl.replace(/\/$/, "")}/v1/solutions/${encodeURIComponent(solutionIdFromTarball(tgzPath, version))}/${version}`,
    { method: "PUT", headers, body: new Uint8Array(body) },
  );
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as { version: string };
}

function solutionIdFromTarball(tgzPath: string, version: string): string {
  const base = tgzPath.split(/[\\/]/).pop() ?? tgzPath;
  const withoutTgz = base.replace(/\.tgz$/, "");
  const withoutVersion = withoutTgz.slice(
    0,
    withoutTgz.length - `-${version}`.length,
  );
  return withoutVersion;
}
