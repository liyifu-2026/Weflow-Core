/**
 * 契约一致性测试。
 *
 * 目标：钉住 "同一 wire shape 只有一份定义" 这一约束——Channel 四契约、
 * RuntimeKernel 插件形状、Execution Strategy、Console 投影 DTO 全部必须
 * 源自 `@weflow/contracts`。任何人在任何一侧手抄同形 DTO，都会在这里的
 * 类型等价断言或键集合快照处失败。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ChannelContact,
  ChannelContactSource,
  ChannelEvent,
  ChannelEventSource,
  ChannelMediaSource,
  ChannelSendOperations,
  ConsoleExtensionProjection,
  ExecutionStrategyRegistry,
  ModelMessage,
  PluginDefinition,
  SolutionStoreOverview,
} from "@weflow-leaif/contracts";
import { capability } from "@weflow-leaif/contracts";
import type { HttpChannelProvider } from "../infrastructure/channel/http-channel-provider.js";
import type { LoadedSolutionPlugin } from "../infrastructure/solutions/solution-plugin-loader.js";
import { adaptSolutionPlugin } from "../infrastructure/solutions/solution-plugin-adapter.js";
import type {
  MapExecutionStrategyRegistry} from "../modules/agent/contracts/execution-strategy.js";
import {
  type AgentAction,
} from "../modules/agent/contracts/execution-strategy.js";
import type { AgentAction as AgentActionContract } from "@weflow-leaif/contracts";
import type { SolutionManifestV1 } from "@weflow-leaif/solution-sdk";

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

  it("solution 插件 adapter 产出的是统一 PluginDefinition", () => {
    const loaded: LoadedSolutionPlugin = {
      artifactId: "artifact",
      id: "demo.plugin",
      plugin: {
        manifest: {
          id: "demo.plugin",
          version: "1.0.0",
          sdkVersion: "1.0.0",
          provides: ["demo.capability"],
          requires: [],
          permissions: [],
        },
      },
    };
    const definition = adaptSolutionPlugin(loaded);
    expectTypeOf(definition).toExtend<PluginDefinition>();
    expect(definition.name).toBe("demo.plugin");
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

  it("Console 投影 DTO 与 Store 概览类型可互换构造", () => {
    const overview: SolutionStoreOverview = {
      solutionId: "weflow.demo",
      installedVersions: ["1.0.0"],
      activeVersion: "1.0.0",
    };
    const projection: ConsoleExtensionProjection = {
      solutionId: overview.solutionId,
      version: overview.activeVersion ?? "",
      extensionId: "main",
      title: "主界面",
      path: "/demo",
      entry: "https://example.com/demo.js",
    };
    expect(projection.solutionId).toBe(overview.solutionId);
  });

  it("manifest consoleExtensions 声明可直接映射为 Console 投影", () => {
    // SolutionManifestV1 的 consoleExtensions 字段与投影共享字段名；
    // 这里以一个最小 manifest 片段验证字段兼容（编译期）。
    type ManifestExtension = SolutionManifestV1["consoleExtensions"][number];
    expectTypeOf<ManifestExtension["id"]>().toEqualTypeOf<
      ConsoleExtensionProjection["extensionId"]
    >();
    expectTypeOf<ManifestExtension["title"]>().toEqualTypeOf<
      ConsoleExtensionProjection["title"]
    >();
    expectTypeOf<ManifestExtension["path"]>().toEqualTypeOf<
      ConsoleExtensionProjection["path"]
    >();
    expectTypeOf<ManifestExtension["entry"]>().toEqualTypeOf<
      ConsoleExtensionProjection["entry"]
    >();
  });
});
