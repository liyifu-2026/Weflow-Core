/**
 * npm registry client for the Weflow Solution marketplace.
 *
 * Thin wrapper over `registry.npmjs.org` covering the three operations the
 * Console marketplace needs:
 *   - list packages under the configured scope (default `@weflow-leaif`)
 *   - fetch version + tarball metadata for one package
 *   - download the tarball to a local file
 *
 * The client is dependency-free (Node 24 `fetch` only) and exposes a
 * `fetchImpl` hook so tests can stub the network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const NPM_DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const NPM_DEFAULT_SCOPE = "@weflow-leaif";

export type NpmMarketFetchOptions = {
  fetchImpl?: typeof globalThis.fetch;
  /** Override the registry base URL (for tests or private mirrors). */
  registryBase?: string;
  /**
   * Optional bearer token sent as `authorization: Bearer <token>`.
   * npm tokens follow the `npm_…` shape; private registries use the same
   * header.
   */
  token?: string | undefined;
  /** Abort signal propagated to fetch (per-request timeouts). */
  signal?: AbortSignal | undefined;
};

export type NpmPackageSummary = {
  name: string;
  version: string;
  description: string;
  publisher: string;
  /** ISO timestamp of the latest published version. */
  publishedAt: string | null;
  /** npm links object (homepage, repository, bugs, npm). */
  links: { npm: string | null; homepage: string | null; repository: string | null };
  /** Icon hint resolved from the manifest when present; empty string otherwise. */
  icon: string;
};

export type NpmPackageVersion = {
  name: string;
  version: string;
  description: string;
  /** sha512 integrity as published by npm (e.g. sha512-…). */
  integrity: string | null;
  /** Absolute URL to the .tgz. */
  tarball: string;
};

export type NpmPackageDetail = {
  name: string;
  description: string;
  publisher: string;
  /** `latest` semver as recorded by npm dist-tags. */
  distTagLatest: string | null;
  /** All published versions, newest first. */
  versions: NpmPackageVersion[];
  /** All dist-tags (e.g. `latest`, `next`). */
  distTags: Record<string, string>;
};

/** Result of a scoped search; see https://registry.npmjs.org/-/v1/search. */
type NpmPublisher = {
  username?: string;
  email?: string;
};

type NpmSearchResponse = {
  objects?: Array<{
    package: {
      name: string;
      version?: string;
      description?: string;
      publisher?: NpmPublisher;
      links?: { npm?: string; homepage?: string; repository?: string };
      date?: string;
    };
  }>;
  total?: number;
};

type NpmAbbreviatedVersion = {
  name: string;
  version: string;
  description?: string;
  dist: {
    tarball: string;
    integrity?: string;
    shasum?: string;
  };
};

type NpmFullDocument = {
  name: string;
  description?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmAbbreviatedVersion>;
};

async function readError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === "string") detail = body.error;
  } catch {
    // fall through to status-only error
  }
  const suffix = detail ? `:${detail}` : "";
  return `npm_http_error:${String(response.status)}${suffix}`;
}

function pickAuthor(publisher: NpmPublisher | undefined | null): string {
  if (!publisher) return "";
  if (typeof publisher.username === "string" && publisher.username.length > 0) {
    return publisher.username;
  }
  if (typeof publisher.email === "string") return publisher.email;
  return "";
}

function isScopedName(name: string, scope: string): boolean {
  return name.startsWith(`${scope}/`);
}

/** Pull a short icon hint from the package description (`icon: foo`). */
function resolveIcon(description: string | undefined): string {
  if (!description) return "";
  const match = /\bicon:\s*([a-z0-9._-]+)\b/i.exec(description);
  return match?.[1] ?? "";
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/$/, "");
  const cleanedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${cleanedPath}`;
}

/**
 * List every package under the configured scope. The result is sorted by
 * package name so the marketplace UI is stable.
 */
export async function searchNpmScope(
  scope: string = NPM_DEFAULT_SCOPE,
  options: NpmMarketFetchOptions = {},
): Promise<NpmPackageSummary[]> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const init: RequestInit = { headers };
  if (options.signal) init.signal = options.signal;
  const url = joinUrl(
    options.registryBase ?? NPM_DEFAULT_REGISTRY,
    `/-/v1/search?text=${encodeURIComponent(
      `scope:${scope}`,
    )}&size=100`,
  );
  const response = await doFetch(url, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const body = (await response.json()) as NpmSearchResponse;
  const summaries: NpmPackageSummary[] = [];
  for (const entry of body.objects ?? []) {
    const pkg = entry.package;
    if (!pkg || !isScopedName(pkg.name, scope)) continue;
    summaries.push({
      name: pkg.name,
      version: typeof pkg.version === "string" ? pkg.version : "",
      description: pkg.description ?? "",
      publisher: pickAuthor(pkg.publisher),
      publishedAt: entry.package.date ?? null,
      links: {
        npm: pkg.links?.npm ?? null,
        homepage: pkg.links?.homepage ?? null,
        repository: pkg.links?.repository ?? null,
      },
      icon: resolveIcon(pkg.description),
    });
  }
  summaries.sort((left, right) => left.name.localeCompare(right.name));
  return summaries;
}

/**
 * Fetch the full package document from the registry, including all versions
 * and dist-tags. Caller is expected to handle the `not_found` error.
 */
export async function fetchNpmPackage(
  name: string,
  options: NpmMarketFetchOptions = {},
): Promise<NpmPackageDetail> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const init: RequestInit = { headers };
  if (options.signal) init.signal = options.signal;
  const url = joinUrl(
    options.registryBase ?? NPM_DEFAULT_REGISTRY,
    `/${name.replace(/^@?/, (match) => (match === "@" ? "@" : match))}`,
  );
  const response = await doFetch(url, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const doc = (await response.json()) as NpmFullDocument;
  const versions: NpmPackageVersion[] = Object.entries(doc.versions ?? {})
    .map(([version, entry]) => ({
      name: entry.name,
      version,
      description: entry.description ?? "",
      integrity: entry.dist?.integrity ?? null,
      tarball: entry.dist?.tarball ?? "",
    }))
    .sort((left, right) => left.version.localeCompare(right.version))
    .reverse();
  const distTags = doc["dist-tags"] ?? {};
  return {
    name: doc.name,
    description: doc.description ?? "",
    publisher: "",
    distTagLatest: typeof distTags.latest === "string" ? distTags.latest : null,
    versions,
    distTags,
  };
}

/**
 * Download a tarball to `destDir/<name>-<version>.tgz`. Returns the absolute
 * path on disk and the bytes downloaded.
 */
export async function downloadNpmTarball(
  name: string,
  version: string,
  destDir: string,
  options: NpmMarketFetchOptions = {},
): Promise<{ tgzPath: string; bytes: number; integrity: string | null; tarball: string }> {
  const detail = await fetchNpmPackage(name, options);
  const entry = detail.versions.find((item) => item.version === version);
  if (!entry) {
    throw new Error(`npm_version_not_found:${name}@${version}`);
  }
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const init: RequestInit = { headers };
  if (options.signal) init.signal = options.signal;
  const response = await doFetch(entry.tarball, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(destDir, { recursive: true });
  const safeName = name.replace(/\//g, "-");
  const tgzPath = join(destDir, `${safeName}-${version}.tgz`);
  await writeFile(tgzPath, bytes);
  return {
    tgzPath,
    bytes: bytes.byteLength,
    integrity: entry.integrity,
    tarball: entry.tarball,
  };
}
