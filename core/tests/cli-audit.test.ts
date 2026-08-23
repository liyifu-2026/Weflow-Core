import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAuditLog,
  auditLogPath,
  readAuditLog,
} from "../infrastructure/solutions/solution-audit.js";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "weflow-audit-"));
  previousHome = process.env.WEFLOW_HOME;
  process.env.WEFLOW_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.WEFLOW_HOME;
  else process.env.WEFLOW_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

describe("solution audit log", () => {
  it("appends one JSON line per entry with timestamp and actor", async () => {
    await appendAuditLog({
      action: "install",
      solutionId: "weflow.demo",
      version: "1.0.0",
      result: "success",
    });
    await appendAuditLog({
      action: "update",
      solutionId: "weflow.demo",
      version: "1.1.0",
      result: "failure",
      errorCode: "solution_health_check_failed",
    });

    const raw = await readFile(auditLogPath(), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(first).toMatchObject({
      action: "install",
      solutionId: "weflow.demo",
      version: "1.0.0",
      result: "success",
    });
    expect(typeof first.timestamp).toBe("string");
    expect(typeof first.actor).toBe("string");
    expect(first.actor).not.toBe("");

    const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    expect(second.errorCode).toBe("solution_health_check_failed");
  });

  it("reads back entries newest-last with an optional limit", async () => {
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      await appendAuditLog({
        action: "install",
        solutionId: "weflow.demo",
        version,
        result: "success",
      });
    }
    const all = await readAuditLog();
    expect(all.map((item) => item.version)).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
    ]);
    const lastTwo = await readAuditLog(2);
    expect(lastTwo.map((item) => item.version)).toEqual(["1.1.0", "1.2.0"]);
  });
});
