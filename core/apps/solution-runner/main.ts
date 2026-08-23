/**
 * Solution Runner process boundary.
 *
 * The Store (`WEFLOW_SOLUTION_STORE`) is the single source of installation
 * truth: `weflowctl solution install/activate` writes it, and this runner
 * only observes it. On startup — and on every poll interval — it resolves the
 * active version of every installed solution, runs the structural health
 * gate, and loads the bundled plugin artifacts so import failures surface
 * here instead of inside request handling.
 *
 * This process never writes the store and never touches the Core database.
 *
 * Environment:
 *   WEFLOW_SOLUTION_STORE          store root (default ~/.weflow/solutions)
 *   SOLUTION_RUNNER_PORT           status endpoint port (default 3201)
 *   SOLUTION_RUNNER_HOST           status endpoint host (default 127.0.0.1)
 *   SOLUTION_RUNNER_INTERVAL_MS    observation interval (default 60000)
 */
import { createServer, type Server } from "node:http";
import { checkSolutionVersionHealth } from "../../infrastructure/solutions/solution-health.js";
import { loadInstalledSolutionPlugins } from "../../infrastructure/solutions/solution-plugin-loader.js";
import {
  getSolutionStoreRoot,
  readActiveVersion,
  storeSolutions,
} from "../../infrastructure/solutions/solution-store.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

type SolutionObservation = {
  solutionId: string;
  version: string | null;
  healthy: boolean;
  reason?: string;
};

type RunnerSnapshot = {
  storeRoot: string;
  observedAt: string;
  solutions: SolutionObservation[];
  pluginCount: number;
};

async function observe(): Promise<RunnerSnapshot> {
  const storeRoot = getSolutionStoreRoot();
  const solutions: SolutionObservation[] = [];
  for (const solutionId of await storeSolutions()) {
    const version = await readActiveVersion(solutionId);
    if (!version) {
      solutions.push({ solutionId, version: null, healthy: true });
      continue;
    }
    const versionDir = join(storeRoot, solutionId, version);
    const health = existsSync(versionDir)
      ? await checkSolutionVersionHealth(versionDir)
      : { ok: false, reason: "version_dir_missing" };
    solutions.push(
      health.ok
        ? { solutionId, version, healthy: true }
        : {
            solutionId,
            version,
            healthy: false,
            reason: health.reason,
          },
    );
  }
  const plugins = await loadInstalledSolutionPlugins();
  return {
    storeRoot,
    observedAt: new Date().toISOString(),
    solutions,
    pluginCount: plugins.length,
  };
}

function sameSnapshot(left: RunnerSnapshot, right: RunnerSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const port = Number(process.env.SOLUTION_RUNNER_PORT ?? "3201");
const host = process.env.SOLUTION_RUNNER_HOST ?? "127.0.0.1";
const intervalMs = Number(process.env.SOLUTION_RUNNER_INTERVAL_MS ?? "60000");

let latest: RunnerSnapshot | undefined;
let stopping = false;

async function poll(logger: { info: (obj: unknown, msg: string) => void }) {
  try {
    const snapshot = await observe();
    if (!latest || !sameSnapshot(latest, snapshot)) {
      latest = snapshot;
      logger.info({ snapshot }, "solution store observation updated");
    }
  } catch (error) {
    logger.info({ err: error }, "solution runner observation failed");
  }
}

const statusServer: Server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  if (latest === undefined) {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: "not_ready" }));
    return;
  }
  response.end(JSON.stringify(latest));
});

const logger = {
  info: (obj: unknown, msg: string): void => {
    console.log(
      JSON.stringify({
        msg,
        ...(typeof obj === "object" && obj !== null ? obj : { detail: obj }),
      }),
    );
  },
};

const timer = setInterval(() => {
  if (!stopping) {
    void poll(logger);
  }
}, intervalMs);
timer.unref();

await poll(logger);
await new Promise<void>((resolveListen) => {
  statusServer.once("error", (error) => {
    logger.info({ err: error }, "solution runner status server failed");
    resolveListen();
  });
  statusServer.listen(port, host, () => {
    resolveListen();
  });
});

logger.info(
  { storeRoot: getSolutionStoreRoot(), port, intervalMs },
  "solution runner ready",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    clearInterval(timer);
    statusServer.close(() => {
      process.exitCode = 0;
    });
  });
}
