/**
 * Append-only audit log for CLI write operations.
 *
 * One JSON object per line at ~/.weflow/audit.log (WEFLOW_HOME aware):
 *   { timestamp, actor, action, solutionId, version, result, errorCode? }
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export type AuditEntry = {
  timestamp: string;
  actor: string;
  action: string;
  solutionId?: string | undefined;
  version?: string | undefined;
  result: "success" | "failure";
  errorCode?: string | undefined;
};

export function auditLogPath(): string {
  return join(
    process.env.WEFLOW_HOME ?? join(homedir(), ".weflow"),
    "audit.log",
  );
}

function currentActor(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USERNAME ?? process.env.USER ?? "unknown";
  }
}

export async function appendAuditLog(
  entry: Omit<AuditEntry, "timestamp" | "actor">,
): Promise<void> {
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    actor: currentActor(),
    ...entry,
  } satisfies AuditEntry)}\n`;
  await mkdir(dirname(auditLogPath()), { recursive: true });
  await appendFile(auditLogPath(), line, "utf8");
}

/** Read audit entries (oldest first), optionally limited to the last n. */
export async function readAuditLog(limit?: number): Promise<AuditEntry[]> {
  let raw: string;
  try {
    raw = await readFile(auditLogPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
  return limit === undefined ? entries : entries.slice(-limit);
}
