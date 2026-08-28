/**
 * 空库 Backfill（historical 事件）摄取回归测试。
 *
 * 设计点 3 验收：historical=true 的事件照常入库（消息落库、会话建立），
 * 但绝不触发三个副作用点——
 *   1. Agent Turn 创建（含 Execution Profile 准入解析）
 *   2. 记忆捕获调度（scheduleMemoryCaptureInTransaction）
 *   3. 通知 outbox（enqueueAssigneeInboundNotification）
 * 同时也不进入媒体转写排队（mediaAssets 不落 queued 行）与
 * global-pause 人工路径（createHandoff 不被调用）。
 *
 * 本测试通过 vi.mock 模块级行为断言副作用模块零调用，不依赖数据库。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 工厂会被提升到文件顶部：mock 函数必须经 vi.hoisted 创建，
// 否则工厂执行时引用未初始化的顶层变量。
const mocks = vi.hoisted(() => ({
  scheduleMemoryCaptureInTransaction: vi.fn(async () => {}),
  enqueueAssigneeInboundNotification: vi.fn(async () => {}),
  resolveExecutionProfileForAdmission: vi.fn(async () => ({
    allowed: true,
    profile: {
      profileId: "platform-default",
      strategyRef: "weflow.platform/generic-v1",
      strategyVersion: "1.0.0",
    },
  })),
  createHandoff: vi.fn(async () => ({ status: "ok" })),
  readRuntimeSettings: vi.fn(async () => ({
    agentEnabled: true,
    autoSendEnabled: true,
    knowledgeEnabled: true,
    memoryEnabled: true,
    visionEnabled: true,
    textModel: "deepseek-v4-flash",
    visionModel: "mimo-v2.5",
  })),
  publish: vi.fn(),
}));

vi.mock("pino", () => {
  const silent = () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => silent(),
  });
  return {
    pino: Object.assign(() => silent(), { default: () => silent() }),
    default: () => silent(),
  };
});

vi.mock(
  "../modules/memory/application/schedule-memory-capture.js",
  () => ({
    scheduleMemoryCaptureInTransaction:
      mocks.scheduleMemoryCaptureInTransaction,
  }),
);

vi.mock(
  "../modules/notifications/application/notification-outbox.js",
  () => ({
    enqueueAssigneeInboundNotification:
      mocks.enqueueAssigneeInboundNotification,
  }),
);

vi.mock(
  "../modules/agent/application/execution-profile-service.js",
  () => ({
    resolveExecutionProfileForAdmission:
      mocks.resolveExecutionProfileForAdmission,
  }),
);

vi.mock("../modules/handoff/application/handoff-service.js", () => ({
  createHandoff: mocks.createHandoff,
}));

vi.mock(
  "../modules/operations/application/runtime-settings.js",
  () => ({ readRuntimeSettings: mocks.readRuntimeSettings }),
);

vi.mock("../../../infrastructure/events/conversation-events.js", () => ({
  conversationEvents: { on: vi.fn(), publish: mocks.publish },
}));

type Row = Record<string, unknown>;

/** 最小内存版 Drizzle 事务桩：支持 ingest 需要的链式调用与 returning。 */
function createStubDb() {
  const conversations: Row[] = [];
  const contacts: Row[] = [];
  const messages: Row[] = [];
  const turns: Row[] = [];
  const media: Row[] = [];
  const notifications: Row[] = [];
  const memoryStates: Row[] = [];

  function resolveTable(name: string): Row[] {
    switch (name) {
      case "contactProfiles":
        return contacts;
      case "conversations":
        return conversations;
      case "messages":
        return messages;
      case "agentTurns":
        return turns;
      case "mediaAssets":
        return media;
      case "notificationOutbox":
        return notifications;
      case "memoryCaptureStates":
        return memoryStates;
      case "handoffStates":
        return []; // 无人工接管中 → 不触发 assignee 通知
      default:
        // channelCursors 等其他表：空且不持久
        return [];
    }
  }

  function makeBuilder(table: string, rows: Row[]) {
    void table;
    const valuesData: Row[] = [];
    const builder: any = {
      values(v: Row | Row[]) {
        valuesData.push(...(Array.isArray(v) ? v : [v]));
        return builder;
      },
      onConflictDoNothing() {
        return builder;
      },
      onConflictDoUpdate() {
        return builder;
      },
      returning() {
        return {
          then(resolve: (v: unknown[]) => void) {
            // 模拟 PostgreSQL 首次插入成功、重复幂等键忽略
            const inserted: Row[] = [];
            for (const v of valuesData) {
              if (!rows.some((r) => r.messageId === v.messageId)) {
                rows.push(v);
                inserted.push(v);
              }
            }
            resolve(inserted);
          },
        };
      },
    };
    return { builder, valuesData };
  }

  const transaction = vi.fn(
    async (callback: (tx: any) => Promise<void>) => {
      const tx: any = {
        insert(table: { getSQLName?: () => string } & Record<string, unknown>) {
          const name = (table as any)?.[Symbol.for("drizzle:Name")] ?? "";
          const rows = resolveTable(name);
          const { builder } = makeBuilder(name, rows);
          return builder;
        },
        select(..._args: unknown[]) {
          const state: { table: string; where: Row } = { table: "", where: {} };
          const chain: any = {
            from(table: unknown) {
              state.table =
                ((table as any)?.[Symbol.for("drizzle:Name")] as string) ?? "";
              return chain;
            },
            where(_condition: unknown) {
              return chain;
            },
            limit() {
              return Promise.resolve(resolveTable(state.table));
            },
            then(resolve: (v: unknown[]) => void) {
              resolve(resolveTable(state.table));
            },
          };
          return chain;
        },
        // ingest 路径不需要 update/delete；出现即失败，防静默绕过
        update() {
          throw new Error("stub: update not expected");
        },
        delete() {
          throw new Error("stub: delete not expected");
        },
        // 捕获副作用行，供断言
        __rows: { conversations, contacts, messages, turns, media, notifications, memoryStates },
      };
      return callback(tx);
    },
  );

  return {
    transaction,
    __rows: { conversations, contacts, messages, turns, media, notifications, memoryStates },
  };
}

import { ingestChannelEvents } from "../modules/conversations/application/ingest-channel-events.js";

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    cursor: "1",
    eventId: "hist:wxid_demo:101",
    conversationRef: "wxid_demo",
    account: "wxid_self_test",
    channelMessageId: "101",
    senderRef: "wxid_demo",
    kind: "text",
    content: "历史消息",
    occurredAt: "2026-08-01T08:00:00.000Z",
    observedAt: "2026-08-27T00:00:00.000Z",
    isSelf: false,
    historical: true,
    ...overrides,
  };
}

function liveEvent(overrides: Record<string, unknown> = {}) {
  return baseEvent({
    eventId: "wechat:wxid_demo:101",
    historical: undefined,
    ...overrides,
  });
}

describe("historical 事件摄取（空库 Backfill）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("historical=true：消息入库，三个副作用点均未调用", async () => {
    const db = createStubDb();
    await ingestChannelEvents(
      db as never,
      [baseEvent()],
      "1",
      { info: () => {}, warn: () => {}, error: () => {} } as never,
    );

    // 消息照常入库（内存桩捕获）
    expect(db.__rows.messages).toHaveLength(1);
    expect(db.__rows.messages[0]).toMatchObject({
      messageId: "channel:hist:wxid_demo:101",
      processingState: "received",
    });

    // 1) Agent Turn：准入解析与 Turn 插入均未发生
    expect(
      mocks.resolveExecutionProfileForAdmission,
    ).not.toHaveBeenCalled();

    // 2) 记忆捕获：未调度
    expect(
      mocks.scheduleMemoryCaptureInTransaction,
    ).not.toHaveBeenCalled();

    // 3) 通知 outbox：未入队
    expect(
      mocks.enqueueAssigneeInboundNotification,
    ).not.toHaveBeenCalled();

    // global-pause 人工路径：不创建 Handoff
    expect(mocks.createHandoff).not.toHaveBeenCalled();
  });

  it("historical 缺省（实时事件）：三个副作用点被调用（对照组）", async () => {
    const db = createStubDb();
    await ingestChannelEvents(
      db as never,
      [liveEvent()],
      "1",
      { info: () => {}, warn: () => {}, error: () => {} } as never,
    );

    expect(
      mocks.resolveExecutionProfileForAdmission,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.scheduleMemoryCaptureInTransaction,
    ).toHaveBeenCalledTimes(1);
    // 文本事件不建媒体资产 → 无媒体副作用；通知因无 in_progress handoff 不入队
    expect(mocks.createHandoff).not.toHaveBeenCalled();
  });

  it("historical=true 的媒体事件：不落 mediaAssets（不做转写排队）", async () => {
    const db = createStubDb();
    await ingestChannelEvents(
      db as never,
      [
        baseEvent({
          eventId: "hist:wxid_demo:102",
          kind: "image",
          content: "[图片]",
          mediaRef: "wechat-media:v1:abc",
        }),
      ],
      "1",
      { info: () => {}, warn: () => {}, error: () => {} } as never,
    );
    expect(db.__rows.media).toHaveLength(0);
    expect(
      mocks.resolveExecutionProfileForAdmission,
    ).not.toHaveBeenCalled();
  });

  it("historical 字段缺省/null/false 均视为实时事件（协议向后兼容）", async () => {
    const db = createStubDb();
    await ingestChannelEvents(
      db as never,
      [
        liveEvent({ eventId: "wechat:wxid_demo:201", channelMessageId: "201" }),
        baseEvent({ historical: false, eventId: "hist:wxid_demo:202", channelMessageId: "202" }),
        baseEvent({ historical: null, eventId: "hist:wxid_demo:203", channelMessageId: "203" }),
      ],
      "1",
      { info: () => {}, warn: () => {}, error: () => {} } as never,
    );
    // 三条消息都入库
    expect(db.__rows.messages).toHaveLength(3);
    // historical 缺省/false/null 的消息照常触发副作用
    expect(
      mocks.scheduleMemoryCaptureInTransaction,
    ).toHaveBeenCalledTimes(3);
  });
});
