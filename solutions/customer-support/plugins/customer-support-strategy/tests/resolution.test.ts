import { test } from "node:test";
import assert from "node:assert/strict";
import { createStrategy, createStrategyApi, strategy } from "../dist/index.js";
import {
  customerSupportSystemPrompt,
  aiEmployeeSystemPrompt,
} from "../dist/prompt.js";
import { DEFAULT_REPLY_WAIT_MS } from "../dist/decision-protocol.js";

// ---------- 假 DB：按 SQL 文本路由返回行，记录全部查询 ----------

type Row = Record<string, unknown>;

function fakeDb(route: (sqlText: string) => Row[] | undefined) {
  const queries: string[] = [];
  return {
    queries,
    execute: async (query: { text?: string }) => {
      const text = String(query?.text ?? "");
      queries.push(text);
      const rows = route(text);
      if (!rows) throw new Error(`db down: ${text.slice(0, 40)}`);
      return { rows };
    },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      text: strings.join("?"),
      values,
    }),
  };
}

const BINDING = "contact_agent_bindings";
const DEFAULT = "workspace_default";
const VERSIONS = "ai_employee_versions";
const SETTINGS = "extension_settings";

function dbWith(
  rows: Partial<
    Record<
      typeof BINDING | typeof DEFAULT | typeof VERSIONS | typeof SETTINGS,
      Row[]
    >
  >,
) {
  return fakeDb((text) => {
    if (text.includes(BINDING)) return rows[BINDING] ?? [];
    if (text.includes(DEFAULT)) return rows[DEFAULT] ?? [];
    if (text.includes(VERSIONS)) return rows[VERSIONS] ?? [];
    if (text.includes(SETTINGS)) return rows[SETTINGS] ?? [];
    return undefined;
  });
}

function buildInput(
  overrides: Partial<
    Parameters<ReturnType<typeof createStrategy>["buildModelRequest"]>[0]
  > = {},
) {
  return {
    contactId: "c1",
    conversationId: "v1",
    availableTools: ["retrieve_knowledge"] as string[],
    messages: [],
    chatType: "private" as const,
    ...overrides,
  };
}

test("静态 strategy：仅内置提示词，无 DB 参与", async () => {
  assert.equal(strategy.version, "1.0.0");
  const request = strategy.buildModelRequest(buildInput({ chatType: "group" }));
  assert.equal(request.system, customerSupportSystemPrompt(true, "group"));
  const parsed = strategy.parseModelResponse({
    text: JSON.stringify({
      next_action: "no_action",
      no_action_reason: "waiting_for_user",
    }),
  }) as { kind: string };
  assert.equal(parsed.kind, "no_action");
});

test("工厂 strategy：版本与 id 契约保持", async () => {
  assert.equal(createStrategy().version, "1.3.0");
  assert.equal(
    createStrategy({ db: {} }).id,
    "weflow.customer-support/structured-v1",
  );
});

test("员工解析：联系人绑定命中 → 成对返回，不查 workspace_default", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [BINDING]: [{ definition_id: "def-1" }],
    [VERSIONS]: [{ prompt: "P1" }],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(api.getCachedAiEmployeeId("c1", "v1"), "def-1");
  const request = api.strategy.buildModelRequest(buildInput());
  assert.equal(request.system, aiEmployeeSystemPrompt("P1", true, "private"));
  assert.equal(db.queries.filter((q) => q.includes(BINDING)).length, 1);
  assert.equal(db.queries.filter((q) => q.includes(VERSIONS)).length, 1);
  assert.equal(db.queries.filter((q) => q.includes(DEFAULT)).length, 0);
});

test("员工解析：绑定未命中 → 工作区默认兜底", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [BINDING]: [],
    [DEFAULT]: [{ default_definition_id: "def-2" }],
    [VERSIONS]: [{ prompt: "P2" }],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(api.getCachedAiEmployeeId("c1", "v1"), "def-2");
  const request = api.strategy.buildModelRequest(buildInput());
  assert.equal(request.system, aiEmployeeSystemPrompt("P2", true, "private"));
});

test("员工解析：全未命中 → 否定结果也缓存（不反复查库），回落内置提示词", async () => {
  const api = createStrategyApi();
  const db = dbWith({ [BINDING]: [], [DEFAULT]: [] });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  const queriesAfterFirst = db.queries.length;
  assert.equal(api.getCachedAiEmployeeId("c1", "v1"), null);
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(db.queries.length, queriesAfterFirst, "缓存命中时不得再查库");
  const request = api.strategy.buildModelRequest(buildInput());
  assert.equal(request.system, customerSupportSystemPrompt(true, "private"));
});

test("员工解析：DB 失败 fail-open（回内置提示词，不抛出）", async () => {
  const api = createStrategyApi();
  const db = dbWith({}); // 无路由 → execute 一律抛
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(api.getCachedAiEmployeeId("c1", "v1"), null);
  const request = api.strategy.buildModelRequest(buildInput());
  assert.equal(request.system, customerSupportSystemPrompt(true, "private"));
});

test("缓存 TTL：过期后重新解析（假时钟驱动）", async () => {
  let now = 1_000_000;
  const api = createStrategyApi({ now: () => now });
  const db = dbWith({
    [BINDING]: [{ definition_id: "def-1" }],
    [VERSIONS]: [{ prompt: "P1" }],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  const queriesAfterFirst = db.queries.length;
  now += 4 * 60_000; // 未到 5 分钟
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(db.queries.length, queriesAfterFirst);
  now += 2 * 60_000; // 越过 5 分钟 TTL
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.ok(db.queries.length > queriesAfterFirst, "TTL 过期后必须重新解析");
});

test("群聊附加指令：从扩展设置读取并拼进提示词（TTL 缓存 + fail-open）", async () => {
  let now = 1_000_000;
  const api = createStrategyApi({ now: () => now });
  const db = dbWith({
    [BINDING]: [{ definition_id: "def-1" }],
    [VERSIONS]: [{ prompt: "P1" }],
    [SETTINGS]: [
      { settings_json: { groupChat: { extraInstruction: "  保持专业。 " } } },
    ],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  const settingsQueries = db.queries.filter((q) => q.includes(SETTINGS)).length;
  const request = api.strategy.buildModelRequest(
    buildInput({ chatType: "group" }),
  );
  assert.equal(
    request.system,
    aiEmployeeSystemPrompt("P1", true, "group", "保持专业。"),
  );
  // TTL 内不重复读设置
  await api.preResolveAiEmployeePrompt(db, "c1", "v2");
  assert.equal(
    db.queries.filter((q) => q.includes(SETTINGS)).length,
    settingsQueries,
  );
  now += 31_000; // 越过 30s 设置 TTL
  await api.preResolveAiEmployeePrompt(db, "c1", "v3");
  assert.ok(
    db.queries.filter((q) => q.includes(SETTINGS)).length > settingsQueries,
    "设置 TTL 过期后必须重新读取",
  );
});

test("群聊附加指令：空白视为未配置；读取失败 fail-open（内置提示词逐字节不受影响）", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [SETTINGS]: [{ settings_json: { groupChat: { extraInstruction: "   " } } }],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  const request = api.strategy.buildModelRequest(
    buildInput({ chatType: "group" }),
  );
  assert.equal(
    request.system,
    customerSupportSystemPrompt(true, "group"),
    "空白指令时必须与未配置逐字节一致",
  );
});

// ---------- 对话节奏：reply/ask 缺 wait_ms 的默认等待 ----------

const REPLY_TEXT = JSON.stringify({
  next_action: "reply",
  reply_segments: ["先看加密狗灯亮不亮。"],
});

function waitMsOf(
  api: ReturnType<typeof createStrategyApi>,
): number | undefined {
  const action = api.strategy.parseModelResponse({ text: REPLY_TEXT }) as {
    waitMs?: number;
  };
  return action.waitMs;
}

test("节奏设置：未配置 → 默认开启（补业务默认等待）", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [SETTINGS]: [
      { settings_json: { groupChat: { extraInstruction: "保持专业。" } } },
    ],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(waitMsOf(api), DEFAULT_REPLY_WAIT_MS);
});

test("节奏设置：pacing.defaultReplyWaitMs=null → 关闭，回到引擎语义", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [SETTINGS]: [{ settings_json: { pacing: { defaultReplyWaitMs: null } } }],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(waitMsOf(api), undefined);
});

test("节奏设置：自定义数值覆盖默认（parser 负责 clamp）", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [SETTINGS]: [
      { settings_json: { pacing: { defaultReplyWaitMs: 120_000 } } },
    ],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(waitMsOf(api), 120_000);
});

test("节奏设置：设置读取失败 fail-open（保持默认值，不抛）", async () => {
  const api = createStrategyApi();
  // SETTINGS 路由未配置 → fakeDb 抛错，preResolve 必须吞掉
  const db = dbWith({});
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  assert.equal(waitMsOf(api), DEFAULT_REPLY_WAIT_MS);
});

test("群聊附加指令：内置提示词路径的拼接字节形态（追加【群聊附加指令】块）", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [SETTINGS]: [
      { settings_json: { groupChat: { extraInstruction: "保持专业。" } } },
    ],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  const request = api.strategy.buildModelRequest(
    buildInput({ chatType: "group", availableTools: [] }),
  );
  assert.equal(
    request.system,
    `${customerSupportSystemPrompt(false, "group")}\n\n【群聊附加指令】保持专业。`,
  );
});

test("私聊请求不携带群聊附加指令（即使设置里有）", async () => {
  const api = createStrategyApi();
  const db = dbWith({
    [BINDING]: [{ definition_id: "def-1" }],
    [VERSIONS]: [{ prompt: "P1" }],
    [SETTINGS]: [
      { settings_json: { groupChat: { extraInstruction: "保持专业。" } } },
    ],
  });
  await api.preResolveAiEmployeePrompt(db, "c1", "v1");
  const request = api.strategy.buildModelRequest(
    buildInput({ chatType: "private" }),
  );
  assert.equal(request.system, aiEmployeeSystemPrompt("P1", true, "private"));
});

test("实例隔离：两个运行时缓存互不串扰（假时钟独立）", async () => {
  let nowA = 0;
  let nowB = 0;
  const apiA = createStrategyApi({ now: () => nowA });
  const apiB = createStrategyApi({ now: () => nowB });
  const dbA = dbWith({
    [BINDING]: [{ definition_id: "def-a" }],
    [VERSIONS]: [{ prompt: "PA" }],
  });
  const dbB = dbWith({ [BINDING]: [] });
  await apiA.preResolveAiEmployeePrompt(dbA, "c1", "v1");
  await apiB.preResolveAiEmployeePrompt(dbB, "c1", "v1");
  assert.equal(apiA.getCachedAiEmployeeId("c1", "v1"), "def-a");
  assert.equal(apiB.getCachedAiEmployeeId("c1", "v1"), null);
});
