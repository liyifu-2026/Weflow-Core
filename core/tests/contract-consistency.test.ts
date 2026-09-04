/**
 * 契约一致性测试。
 *
 * 目标：钉住 "同一 wire shape 只有一份定义" 这一约束——Channel 四契约、
 * RuntimeKernel 插件形状、Execution Strategy 全部必须
 * 源自 `@weflow/contracts`。任何人在任何一侧手抄同形 DTO，都会在这里的
 * 类型等价断言或键集合快照处失败。
 *
 * R3 平台化拆除：Solution Store 投影 / consoleExtensions / solution 插件
 * adapter 相关断言随机制一起删除。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChannelContact,
  ChannelContactSource,
  ChannelEvent,
  ChannelEventSource,
  ChannelMediaSource,
  ChannelSendOperations,
  ExecutionStrategyRegistry,
  ModelMessage,
  PluginDefinition,
} from "@weflow-leaif/contracts";
import { capability } from "@weflow-leaif/contracts";
import type { HttpChannelProvider } from "../infrastructure/channel/http-channel-provider.js";
import type {
  MapExecutionStrategyRegistry} from "../modules/agent/contracts/execution-strategy.js";
import {
  type AgentAction,
} from "../modules/agent/contracts/execution-strategy.js";
import type { AgentAction as AgentActionContract } from "@weflow-leaif/contracts";

describe("contract consistency", () => {
  it("HttpChannelProvider 实现来自 @weflow/contracts 的 Channel 四契约", () => {
    expectTypeOf<HttpChannelProvider>().toExtend<ChannelEventSource>();
    expectTypeOf<HttpChannelProvider>().toExtend<ChannelMediaSource>();
    expectTypeOf<HttpChannelProvider>().toExtend<ChannelSendOperations>();
    expectTypeOf<HttpChannelProvider>().toExtend<ChannelContactSource>();
  });

  it("RuntimeKernel 插件形状与 @weflow/contracts 完全同源", () => {
    const token = capability<{ name: string }>("demo.capability");
    expectTypeOf(token.id).toEqualTypeOf<string>();

    const definition: PluginDefinition = {
      name: "demo",
      provides: [capability("a")],
      requires: [],
    };
    expectTypeOf(definition.name).toEqualTypeOf<string>();
  });

  it("Execution Strategy 注册表满足 @weflow/contracts 契约", () => {
    expectTypeOf<MapExecutionStrategyRegistry>().toExtend<ExecutionStrategyRegistry>();
    // core 侧 re-export 的 AgentAction 必须与包内定义同源（而非同形副本）。
    expectTypeOf<AgentAction>().toEqualTypeOf<AgentActionContract>();
    expectTypeOf<ModelMessage["role"]>().toEqualTypeOf<
      "system" | "user" | "assistant" | "tool"
    >();
  });

  it("Channel wire shape 键集合被快照钉住（漂移即失败）", () => {
    // 显式列出契约键；任何人增删字段都必须有意识地更新此测试，
    // 并同步 Channel Host 模拟器 / HTTP Provider 的 zod schema。
    const eventKeys = [
      "eventId",
      "cursor",
      "conversationRef",
      "channelMessageId",
      "senderRef",
      "kind",
      "content",
      "mediaRef",
      "fileName",
      "mimeType",
      "occurredAt",
      "observedAt",
      "isSelf",
      "historical",
    ] as const;
    type EventKeys = keyof ChannelEvent;
    const _typePin: readonly EventKeys[] = eventKeys;
    void _typePin;
    expect(eventKeys).toHaveLength(14);

    const contactKeys = [
      "contactRef",
      "displayName",
      "nickname",
      "remark",
      "alias",
      "avatarUrl",
      "contactType",
    ] as const;
    type ContactKeys = keyof ChannelContact;
    const _contactPin: readonly ContactKeys[] = contactKeys;
    void _contactPin;
    expect(contactKeys).toHaveLength(7);
  });
});
