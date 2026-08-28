/**
 * dev doctor 检查器 + 进程托管 单元测试（node:test，fake 探测注入）。
 * 运行：node <core>/node_modules/tsx/dist/cli.mjs --test test/*.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  checkChannelProtocol,
  checkEnv,
  checkPostgres,
  checkService,
  runDoctor,
  serviceChecks,
  summarize,
  type CheckStatus,
} from "../src/dev/checks.js";
import { REQUIRED_ENV_KEYS, type EnvMap, type ServiceDefinition } from "../src/dev/definitions.js";
import { readPidFile, writePidFile } from "../src/dev/process-manager.js";
import type { Probe } from "../src/dev/probe.js";

const ENV: EnvMap = {
  DATABASE_URL: "postgresql://weflow:weflow@127.0.0.1:5432/weflow",
  REDIS_URL: "redis://127.0.0.1:6379",
  CORE_PORT: "3100",
  CHANNEL_HOST_BASE_URL: "http://127.0.0.1:43123",
  CHANNEL_HOST_TOKEN: "token",
  MODEL_BASE_URL: "https://api.deepseek.com",
  MODEL_NAME: "deepseek-v4-flash",
  MODEL_API_KEY: "sk-test",
  WEKNORA_BASE_URL: "http://127.0.0.1:8080",
  WEKNORA_API_KEY: "wk-test",
};

function service(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    key: "core-api",
    label: "Core API",
    port: () => 3100,
    probe: { type: "http", path: "/health/ready", accept401: false },
    required: true,
    mtimePaths: ["C:/src/main.ts"],
    start: ["node", "main.ts"],
    cwd: "C:/src",
    identity: ["C:/weflow/core/apps/api"],
    elevated: false,
    ...overrides,
  };
}

function fakeProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    tcp: async () => true,
    http: async () => ({ status: 200 }),
    portOwners: async () => new Map(),
    fileMtime: async () => undefined,
    ...overrides,
  };
}

describe("checkEnv", () => {
  it("完整 env 通过", () => {
    assert.equal(checkEnv(ENV, REQUIRED_ENV_KEYS).status, "pass");
  });
  it("缺失键 → fail", () => {
    const env = { ...ENV };
    delete env.MODEL_API_KEY;
    const result = checkEnv(env, REQUIRED_ENV_KEYS);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /MODEL_API_KEY/);
  });
  it("允许 *_FILE 注入形式", () => {
    const env = { ...ENV };
    delete env.MODEL_API_KEY;
    env.MODEL_API_KEY_FILE = "C:/secrets/model.key";
    assert.equal(checkEnv(env, REQUIRED_ENV_KEYS).status, "pass");
  });
});

describe("checkPostgres", () => {
  it("空库（无业务表）→ fail", async () => {
    const result = await checkPostgres(ENV, fakeProbe(), { count: 0, hasCoreTables: false });
    assert.equal(result.status, "fail");
    assert.match(result.detail, /空库|业务表缺失/);
  });
  it("有业务表 → pass", async () => {
    const result = await checkPostgres(ENV, fakeProbe(), { count: 42, hasCoreTables: true });
    assert.equal(result.status, "pass");
  });
  it("DB 检查不可用 → 降级为端口可达 pass", async () => {
    const result = await checkPostgres(ENV, fakeProbe(), undefined);
    assert.equal(result.status, "pass");
  });
  it("端口不可达 → fail", async () => {
    const result = await checkPostgres(
      ENV,
      fakeProbe({ tcp: async () => false }),
      { count: 42, hasCoreTables: true },
    );
    assert.equal(result.status, "fail");
    assert.match(result.detail, /不可达/);
  });
});

describe("checkService", () => {
  it("端口无监听 → not_running", async () => {
    const { status } = await checkService(service(), ENV, fakeProbe());
    assert.equal(status.kind, "not_running");
  });

  it("陌生进程占端口 → foreign_owner（今天 3100 事故的判据）", async () => {
    const probe = fakeProbe({
      portOwners: async () =>
        new Map([[3100, [{ pid: 22964, cmdline: "C:/some/other/node app.js" }]]]),
    });
    const { status } = await checkService(service(), ENV, probe);
    assert.equal(status.kind, "foreign_owner");
    assert.match(status.detail, /22964/);
  });

  it("本项目进程 + 探针通过 → pass", async () => {
    const probe = fakeProbe({
      portOwners: async () =>
        new Map([[3100, [{ pid: 1001, cmdline: "node C:/weflow/core/apps/api/main.ts" }]]]),
      http: async () => ({ status: 200 }),
    });
    const { status } = await checkService(service(), ENV, probe);
    assert.equal(status.kind, "pass");
  });

  it("探针失败 → probe_failed", async () => {
    const probe = fakeProbe({
      portOwners: async () => new Map([[3100, [{ pid: 1001, cmdline: "node C:/weflow/core/apps/api/main.ts" }]]]),
      http: async () => undefined,
    });
    const { status } = await checkService(service(), ENV, probe);
    assert.equal(status.kind, "probe_failed");
  });

  it("源码 mtime 晚于进程启动 → stale（旧进程判据）", async () => {
    const now = Date.now();
    const probe = fakeProbe({
      portOwners: async () =>
        new Map([[3100, [{ pid: 1001, cmdline: "node C:/weflow/core/apps/api/main.ts", startedAt: now - 3_600_000 }]]]),
      http: async () => ({ status: 200 }),
      fileMtime: async () => now,
    });
    const { status } = await checkService(service(), ENV, probe);
    assert.equal(status.kind, "stale");
  });

  it("channel-host 探针 401 → 视为活着（accept401）", async () => {
    const host = service({
      key: "channel-host",
      port: () => 43123,
      identity: ["C:/weflow/runtimes/channel-host-wechat/channel_host"],
      probe: { type: "http", path: "/healthz", accept401: true },
    });
    const probe = fakeProbe({
      portOwners: async () =>
        new Map([[43123, [{ pid: 2002, cmdline: "python C:/weflow/runtimes/channel-host-wechat/channel_host/main.py" }]]]),
      http: async () => ({ status: 401 }),
    });
    const { status } = await checkService(host, ENV, probe);
    assert.equal(status.kind, "pass");
  });
});

describe("serviceChecks 折叠级别", () => {
  it("required 服务未运行 → fail", async () => {
    const results = await serviceChecks([service()], ENV, fakeProbe());
    assert.equal(results[0]?.status, "fail");
  });
  it("optional 服务未运行 → warn", async () => {
    const optional = service({ required: false, key: "solution-registry" });
    const results = await serviceChecks([optional], ENV, fakeProbe());
    assert.equal(results[0]?.status, "warn");
  });
  it("stale → warn（不阻塞 up 成功）", async () => {
    const now = Date.now();
    const stale = service({ key: "agent-worker" });
    const probe = fakeProbe({
      portOwners: async () =>
        new Map([[3100, [{ pid: 1001, cmdline: "node C:/weflow/core/apps/api/main.ts", startedAt: now - 3_600_000 }]]]),
      http: async () => ({ status: 200 }),
      fileMtime: async () => now,
    });
    const results = await serviceChecks([stale], ENV, probe);
    assert.equal(results[0]?.status, "warn");
  });
});

describe("runDoctor + summarize", () => {
  it("汇总计数正确", async () => {
    const results = await runDoctor({
      env: ENV,
      services: [service()],
      probe: fakeProbe({
        portOwners: async () => new Map([[3100, [{ pid: 1001, cmdline: "node C:/weflow/core/apps/api/main.ts" }]]]),
      }),
      dbTables: { count: 42, hasCoreTables: true },
      pidFile: { "core-api": { pid: 1001, startedAt: Date.now(), elevated: false } },
    });
    const statuses = results.map((r) => r.status as CheckStatus);
    assert.equal(statuses.filter((s) => s === "pass").length, 4); // env + postgres + redis + core-api
    assert.equal(statuses.filter((s) => s === "fail").length, 0);
  });
});

describe("checkChannelProtocol", () => {
  const protocol = {
    protocolVersion: 4,
    sendOperationStates: ["pending", "executing", "confirmed", "unknown", "failed"],
    sendKinds: ["text", "file", "image", "reply", "mention", "poke", "recall", "voice"],
  };
  const envWithHost = {
    ...ENV,
    CHANNEL_HOST_BASE_URL: "http://127.0.0.1:43123",
    CHANNEL_HOST_TOKEN: "token",
  };

  it("host 能力与权威一致 → pass", async () => {
    const probe = fakeProbe({
      http: async () => ({ status: 200 }),
    });
    // fakeProbe.http 返回 200 后，checkChannelProtocol 会再用 globalThis.fetch
    // 请求真实能力——这里用全局 fetch stub 返回匹配的能力
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          sendOperationStates: protocol.sendOperationStates,
          sendKinds: protocol.sendKinds,
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const result = await checkChannelProtocol(envWithHost, probe, protocol);
      assert.equal(result.status, "pass");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("版本失配 + 缺枚举 → fail 并列出差异", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          protocolVersion: 2,
          sendOperationStates: ["pending", "confirmed"],
          sendKinds: ["text"],
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      const result = await checkChannelProtocol(envWithHost, fakeProbe({ http: async () => ({ status: 200 }) }), protocol);
      assert.equal(result.status, "fail");
      assert.match(result.detail, /protocolVersion 2 != 1/);
      assert.match(result.detail, /缺 sendOperationState: executing/);
      assert.match(result.detail, /缺 sendKind: file/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("host 不可达 → warn（不阻塞）", async () => {
    const result = await checkChannelProtocol(
      envWithHost,
      fakeProbe({ http: async () => undefined }),
      protocol,
    );
    assert.equal(result.status, "warn");
  });

  it("配置缺失 → warn 跳过", async () => {
    const envNoHost = { ...ENV };
    delete envNoHost.CHANNEL_HOST_BASE_URL;
    const result = await checkChannelProtocol(envNoHost, fakeProbe(), protocol);
    assert.equal(result.status, "warn");
  });
});


describe("PID 文件", () => {
  it("写入后读回一致，删除生效", () => {
    const dir = mkdtempSync(join(tmpdir(), "weflowctl-test-"));
    const file = join(dir, "dev-pids.json");
    try {
      writePidFile(file, { "core-api": { pid: 1001, startedAt: 1, elevated: false } });
      assert.deepEqual(readPidFile(file), { "core-api": { pid: 1001, startedAt: 1, elevated: false } });
      assert.deepEqual(readPidFile(join(dir, "missing.json")), {});
      // 直接写不存在的路径也应成功（mkdirSync recursive）
      const nested = join(dir, "a", "b", "pids.json");
      writePidFile(nested, { x: { pid: 1, startedAt: 1, elevated: false } });
      assert.ok(readPidFile(nested).x);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("损坏的 JSON → 空记录（不炸）", () => {
    const dir = mkdtempSync(join(tmpdir(), "weflowctl-test-"));
    const file = join(dir, "dev-pids.json");
    try {
      writeFileSync(file, "not json", "utf8");
      assert.deepEqual(readPidFile(file), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
