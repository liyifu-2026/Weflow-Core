/**
 * Solution Registry process boundary.
 *
 * A stateless HTTP facade over a local package directory:
 *   GET  /v1/solutions                -> registry listing
 *   GET  /v1/solutions/:id            -> version index
 *   GET  /v1/solutions/:id/:version   -> entry metadata
 *   GET  /v1/solutions/:id/:version.tgz -> tarball
 *   PUT  /v1/solutions/:id/:version   -> publish (bearer token, verified)
 *
 * Environment:
 *   SOLUTION_REGISTRY_PORT            default 3200
 *   HEALTH_HOST                       default 127.0.0.1
 *   WEFLOW_SOLUTION_REGISTRY_ROOT     default ~/.weflow/registry
 *   WEFLOW_SOLUTION_REGISTRY_TOKEN    required for publishing when set;
 *                                     publishing is disabled without it
 *   WEFLOW_SOLUTION_REGISTRY_READ_TOKEN
 *                                     required for reads when set (defaults
 *                                     to the publish token)
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { registerSolutionRegistryRoutes } from "../../infrastructure/solutions/solution-registry-routes.js";

const port = Number(process.env.SOLUTION_REGISTRY_PORT ?? "3200");
const host = process.env.HEALTH_HOST ?? "127.0.0.1";
const root = resolve(
  process.env.WEFLOW_SOLUTION_REGISTRY_ROOT ??
    join(homedir(), ".weflow", "registry"),
);
const publishToken = process.env.WEFLOW_SOLUTION_REGISTRY_TOKEN;
const readToken =
  process.env.WEFLOW_SOLUTION_REGISTRY_READ_TOKEN ?? publishToken;

const app = Fastify({
  logger: true,
  ...(process.env.LOG_LEVEL ? { logLevel: process.env.LOG_LEVEL } : {}),
});
registerSolutionRegistryRoutes(app, {
  root,
  ...(publishToken !== undefined ? { publishToken } : {}),
  ...(readToken !== undefined ? { readToken } : {}),
});

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exitCode = 0;
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}

await app.listen({ port, host });
