/**
 * Weflow Core API 入口
 *
 * 职责：
 * - 注册所有业务模块的 HTTP API 路由（身份、对话、联系人、内存、媒体、代理等）
 * - 启动 Redis 消息队列调度器（Agent Turn、内存捕获、媒体处理、推送通知）
 * - 启动 Channel Host 轮询器，从 Channel Host 同步通道事件
 */
import { runProcess } from "../../infrastructure/runtime/run-process.js";
import multipart from "@fastify/multipart";
import { LocalFileStorage } from "../../infrastructure/file_storage/local-file-storage.js";
import { registerCors } from "../../infrastructure/http/cors.js";
import {
  registerWebStatic,
  resolveWebDistDir,
} from "../../infrastructure/http/web-static.js";
import { startAgentTurnDispatcher } from "../../infrastructure/redis/agent-turn-dispatcher.js";
import { loadInstalledBackendPlugins } from "../../infrastructure/solutions/backend-plugin-loader.js";
import { startMemoryCaptureDispatcher } from "../../infrastructure/redis/memory-capture-dispatcher.js";
import { startMediaProcessingDispatcher } from "../../infrastructure/redis/media-processing-dispatcher.js";
import { startTurnAdmissionDispatcher } from "../../modules/conversations/application/start-turn-admission-dispatcher.js";
import { processDueScheduledSends } from "../../modules/agent/application/scheduled-sends.js";
import { processTurnAdmissions } from "../../modules/conversations/application/process-turn-admissions.js";
import {
  HttpChannelProvider,
  httpChannelPlugin,
} from "../../infrastructure/channel/http-channel-provider.js";
import { startChannelEventPoller } from "../../infrastructure/channel/channel-event-poller.js";
import { startChannelOutboundPoller } from "../../infrastructure/channel/channel-outbound-poller.js";
import { startChannelMediaPoller } from "../../infrastructure/channel/channel-media-poller.js";
import { startChannelContactPoller } from "../../infrastructure/channel/channel-contact-poller.js";
import { CHANNEL_EVENTS_CAPABILITY } from "../../infrastructure/runtime/capabilities/channel-events.js";
import { CHANNEL_MEDIA_CAPABILITY } from "../../infrastructure/runtime/capabilities/channel-media.js";
import { CHANNEL_SEND_CAPABILITY } from "../../infrastructure/runtime/capabilities/channel-send.js";
import { CHANNEL_CONTACTS_CAPABILITY } from "../../infrastructure/runtime/capabilities/channel-contacts.js";
import { RuntimeKernel } from "../../infrastructure/runtime/kernel/index.js";
import { registerConversationRoutes } from "../../modules/conversations/interface/http-routes.js";
import { registerConsoleEventRoutes } from "../../modules/console-events/interface/http-routes.js";
import { startConversationEventBus } from "../../infrastructure/events/conversation-events.js";
import { registerHandoffRoutes } from "../../modules/handoff/interface/http-routes.js";
import { registerIdentityRoutes } from "../../modules/identity/interface/http-routes.js";
import { registerContactProfileRoutes } from "../../modules/contacts/interface/http-routes.js";
import { registerContactAvatarRoutes } from "../../modules/contacts/interface/avatar-routes.js";
import { AvatarProxyService } from "../../modules/contacts/application/avatar-proxy-service.js";
import { registerMemoryRoutes } from "../../modules/memory/interface/http-routes.js";
import { registerScheduledSendRoutes } from "../../modules/agent/interface/scheduled-send-routes.js";
import { registerMediaRoutes } from "../../modules/media/interface/http-routes.js";
import { registerAssetRoutes } from "../../modules/assets/interface/http-routes.js";
import { registerNotificationRoutes } from "../../modules/notifications/interface/http-routes.js";
import { registerCollaborationRoutes } from "../../modules/collaboration/interface/http-routes.js";
import { registerKnowledgeRoutes } from "../../modules/knowledge/interface/http-routes.js";
import { OpenAiCompatibleClient } from "../../infrastructure/model_runtime/openai-compatible-client.js";
import { WeKnoraKnowledgeClient } from "../../infrastructure/knowledge/weknora-knowledge-client.js";
import { startExpoPushDispatcher } from "../../infrastructure/notifications/expo-push-dispatcher.js";
import { registerKnowledgeProviderRoutes } from "../../modules/knowledge-provider/interface/http-routes.js";
import { registerKnoraBridgeRoutes } from "../../modules/knora-bridge/interface/http-routes.js";
import { registerOperationsRoutes } from "../../modules/operations/interface/http-routes.js";
import { inspectKnowledgeEngine } from "../../modules/knowledge-provider/application/boundary.js";
import { startMobileHandoffMaintenance } from "../../modules/handoff/application/mobile-handoff-service.js";
import { startMemoryMaintenance } from "../../modules/memory/application/memory-maintenance.js";
import { routeMediaToHuman } from "../../modules/handoff/application/route-media-to-human.js";
import { readRuntimeSettings } from "../../modules/operations/application/runtime-settings.js";
import { createCachedExtensionSettingsReader } from "../../infrastructure/settings/extension-settings.js";
import {
  extractGroupChatSettings,
  resolveGroupChatPolicy,
} from "../../modules/agent/application/group-chat-policy.js";
import {
  currentChannelCursor,
  ingestChannelEvents,
} from "../../modules/conversations/application/ingest-channel-events.js";
import { processOutboundMessages } from "../../modules/conversations/application/process-outbound-messages.js";
import { syncChannelMedia } from "../../modules/media/application/sync-channel-media.js";
import { upgradeChannelImageOriginals } from "../../modules/media/application/upgrade-channel-image-originals.js";
import { syncChannelContactProfiles } from "../../modules/contacts/application/sync-channel-contact-profiles.js";

/** 启动 Core API 进程 */
await runProcess({
  name: "core-api",
  healthPort: (config) => config.corePort,
  /** 配置 HTTP 服务器，注册所有业务模块的路由 */
  configureServer: async (server, { config, postgres, logger }) => {
    registerCors(server, config.corsOrigins);
    // 产品网页端静态托管（R4 部署形态）：生产环境由 api 进程直接托管
    // support-web 构建产物，不再依赖 Vite dev server。未配置时跳过。
    const webDistDir = resolveWebDistDir(config.webDistDir);
    if (webDistDir) {
      await registerWebStatic(server, webDistDir);
      logger.info({ webDistDir }, "serving web dist");
    }
    await server.register(multipart, {
      limits: { fileSize: 100 * 1_024 * 1_024, files: 1 },
    });
    registerIdentityRoutes(
      server,
      postgres.db,
      new LocalFileStorage(`${config.fileStorageRoot}/identity`),
    );
    registerConversationRoutes(server, postgres.db, config.channelHost);
    registerConsoleEventRoutes(server, postgres.db);
    registerContactProfileRoutes(server, postgres.db);
    registerContactAvatarRoutes(
      server,
      postgres.db,
      new AvatarProxyService({
        allowedHosts: config.avatar.allowedHosts,
        timeoutMs: config.avatar.proxyTimeoutMs,
        cacheTtlMs: config.avatar.cacheTtlMs,
      }),
    );
    registerHandoffRoutes(server, postgres.db);
    registerMemoryRoutes(server, postgres.db);
  registerScheduledSendRoutes(server, postgres.db);
    registerMediaRoutes(server, postgres.db, `${config.fileStorageRoot}/media`);
    registerAssetRoutes(
      server,
      postgres.db,
      new LocalFileStorage(`${config.fileStorageRoot}/assets`),
    );
    registerNotificationRoutes(server, postgres.db);
    registerCollaborationRoutes(server, postgres.db);
    const knowledgeClient = config.weknora
      ? new WeKnoraKnowledgeClient(config.weknora)
      : undefined;
    registerKnowledgeRoutes(server, postgres.db, {
      weknora: knowledgeClient,
      model: config.model
        ? new OpenAiCompatibleClient({
            baseUrl: config.model.baseUrl,
            apiKey: config.model.apiKey,
            model: config.model.name,
            timeoutMs: config.model.timeoutMs,
          })
        : undefined,
    });
    registerKnowledgeProviderRoutes(server, postgres.db, config.weknora);
    registerKnoraBridgeRoutes(server, postgres.db, {
      weknora: config.weknora,
      encKey: config.knoraBridge.encKey,
      tenantId: config.knoraBridge.tenantId,
      emailDomain: config.knoraBridge.emailDomain,
      origin: config.knoraBridge.origin,
    });
    registerOperationsRoutes(
      server,
      postgres.db,
      {
        channelHostConfigured: Boolean(config.channelHost),
        modelConfigured: Boolean(config.model),
        knowledgeConfigured: Boolean(config.weknora),
        inspectKnowledge: () => inspectKnowledgeEngine(config.weknora),
        inspectChannelHost: async () => {
          if (!config.channelHost)
            return { status: "not_configured" as const, summary: "尚未配置" };
          try {
            const response = await fetch(
              `${config.channelHost.baseUrl}/api/v1/status`,
              {
                headers: {
                  authorization: `Bearer ${config.channelHost.token}`,
                },
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (!response.ok)
              return {
                status: "unreachable" as const,
                summary: `状态端点返回 ${String(response.status)}`,
              };
            return { status: "healthy" as const, summary: "服务可访问" };
          } catch {
            return {
              status: "unreachable" as const,
              summary: "连接失败",
            };
          }
        },
        inspectModel: async () => {
          if (!config.model)
            return { status: "not_configured" as const, summary: "尚未配置" };
          try {
            const response = await fetch(`${config.model.baseUrl}/models`, {
              headers: { authorization: `Bearer ${config.model.apiKey}` },
              signal: AbortSignal.timeout(5_000),
            });
            if (!response.ok)
              return {
                status: "unreachable" as const,
                summary: `模型端点返回 ${String(response.status)}`,
              };
            return { status: "healthy" as const, summary: "服务可访问" };
          } catch {
            return {
              status: "unreachable" as const,
              summary: "连接失败",
            };
          }
        },
      },
      {
        textModel: {
          name: config.model?.name ?? "deepseek-v4-flash",
          baseUrl: config.model?.baseUrl ?? "https://api.deepseek.com",
          ...(config.model?.apiKey !== undefined
            ? { apiKey: config.model.apiKey }
            : {}),
        },
        visionModel: {
          name: config.vision?.name ?? "mimo-v2.5",
          baseUrl: config.vision?.baseUrl ?? "",
          ...(config.vision?.apiKey !== undefined
            ? { apiKey: config.vision.apiKey }
            : {}),
        },
        asrModel: {
          name: config.asr?.model ?? config.vision?.asrModel ?? "mimo-v2.5",
          baseUrl: config.asr?.baseUrl ?? config.vision?.baseUrl ?? "",
          ...(config.asr?.apiKey !== undefined
            ? { apiKey: config.asr.apiKey }
            : config.vision?.apiKey !== undefined
              ? { apiKey: config.vision.apiKey }
              : {}),
        },
        ...(config.triage
          ? {
              triageModel: {
                name: config.triage.model,
                baseUrl: config.triage.baseUrl,
                apiKey: config.triage.apiKey,
              },
            }
          : {}),
        ...(config.fast
          ? {
              fastModel: {
                name: config.fast.model,
                baseUrl: config.fast.baseUrl,
                apiKey: config.fast.apiKey,
              },
            }
          : {}),
      },
    );
    // 业务 Solution 的 backend 插件（BFF）：从 WEFLOW_PLUGIN_DIR 直读
    // 业务路由（如 AI Employees）。加载失败只降级告警。
    await loadInstalledBackendPlugins(server, {
      db: postgres.db,
      logger,
    });
  },
  /** 启动后台调度器和正式 Channel Host 轮询器，返回清理函数 */
  start: async ({ config, logger, postgres }) => {
    // 跨进程事件总线：api 是 SSE 消费端，必须订阅 worker 侧发布的事件
    // （Agent 回复、媒体转写完成），否则这些事件到不了前端连接。
    const stopConversationEventBus = startConversationEventBus({
      redisUrl: config.redisUrl,
      logger,
      subscribe: true,
    });
    let channelKernel: RuntimeKernel | undefined;
    if (config.channelHost) {
      channelKernel = new RuntimeKernel();
      channelKernel.register(
        httpChannelPlugin(
          new HttpChannelProvider({
            baseUrl: config.channelHost.baseUrl,
            token: config.channelHost.token,
          }),
        ),
      );
      await channelKernel.start();
    }
    const stopMobileHandoffMaintenance = startMobileHandoffMaintenance(
      postgres.db,
      logger,
    );
    // 启动 Agent Turn 调度器，处理对话中的代理轮次
    const stopAgentTurnDispatcher = startAgentTurnDispatcher({
      db: postgres.db,
      redisUrl: config.redisUrl,
      logger,
    });
    // 启动内存捕获调度器，异步处理对话记忆的持久化
    const stopMemoryCaptureDispatcher = startMemoryCaptureDispatcher({
      db: postgres.db,
      redisUrl: config.redisUrl,
      logger,
    });
    // 合并窗口调度器（Phase 1）：到期登记合并建 Turn；CAS 认领多实例安全
    const stopTurnAdmissionDispatcher = startTurnAdmissionDispatcher({
      process: () => processTurnAdmissions(postgres.db, logger),
      logger,
    });
    // 定时发送 dispatcher（SCHEDULED-SEND-PLAN）：到点直发预承诺内容，
    // 不调用模型；护栏（handoff 冻结 / 白名单摘除作废 / 静音顺延）全代码持有。
    const stopScheduledSendDispatcher = startTurnAdmissionDispatcher({
      process: async () =>
        processDueScheduledSends(postgres.db, undefined, {
          error: (obj, msg) => logger.error(obj as object, msg),
          info: (obj, msg) => logger.info(obj as object, msg),
        }),
      intervalMs: 5_000,
      logger,
    });
    const stopMemoryMaintenance = startMemoryMaintenance(postgres.db, logger);
    // 启动媒体处理调度器，处理入站媒体文件的转码和存储。
    // 业务依赖由组合根绑定：infrastructure 的 dispatcher/poller 不反向依赖 modules。
    const stopMediaProcessingDispatcher = startMediaProcessingDispatcher({
      db: postgres.db,
      redisUrl: config.redisUrl,
      logger,
      visionConfigured: Boolean(config.vision),
      // ASR 与视觉共用 MiMo 端点与密钥（asrModel 由 ASR_MODEL 配置）
      asrConfigured: Boolean(config.vision?.asrModel),
      dependencies: {
        readSettings: (db) => readRuntimeSettings(db),
        routeToHuman: (input) => routeMediaToHuman(postgres.db, logger, input),
      },
    });
    // 启动 Expo 推送通知调度器
    const stopPushDispatcher = startExpoPushDispatcher({
      db: postgres.db,
      logger,
    });
    if (config.channelHost && channelKernel) {
      const channelSource = channelKernel.get(CHANNEL_EVENTS_CAPABILITY);
      const channelMedia = channelKernel.get(CHANNEL_MEDIA_CAPABILITY);
      const channelSendOperations = channelKernel.get(CHANNEL_SEND_CAPABILITY);
      const channelContacts = channelKernel.get(CHANNEL_CONTACTS_CAPABILITY);
      // 群聊策略读取器：读客服 Solution 扩展设置（30s TTL 缓存），
      // 群 override > 全局 > 平台默认（仅@）；读取失败逐项回落默认。
      const readGroupChatSettings = createCachedExtensionSettingsReader(
        postgres.db,
        {
          solutionId: "weflow.customer-support",
          extensionId: "support-pipeline",
        },
      );
      const stopChannelHostPoller = startChannelEventPoller({
        source: channelSource,
        db: postgres.db,
        logger,
        intervalMs: config.channelHost.pollIntervalMs,
        dependencies: {
          currentCursor: (db) =>
            currentChannelCursor(db, "channel-host").then(String),
          ingestEvents: (db, events, nextCursor) =>
            ingestChannelEvents(db, events, nextCursor, logger, {
              resolvePolicy: async (conversationRef) => {
                try {
                  return resolveGroupChatPolicy(
                    extractGroupChatSettings(await readGroupChatSettings()),
                    conversationRef,
                  );
                } catch {
                  return extractGroupChatSettings(undefined).global;
                }
              },
            }),
        },
      });
      const stopChannelHostOutboundPoller = startChannelOutboundPoller({
        db: postgres.db,
        logger,
        intervalMs: config.channelHost.pollIntervalMs,
        sendOutbound: (db) =>
          processOutboundMessages(db, channelSendOperations, {
            fileStorageRoot: config.fileStorageRoot,
            logger: {
              warn: (obj, msg) => logger.warn(obj, msg),
            },
          }),
      });
      const stopChannelHostMediaPoller = startChannelMediaPoller({
        db: postgres.db,
        logger,
        intervalMs: config.channelHost.pollIntervalMs,
        syncMedia: (db) =>
          syncChannelMedia(
            db,
            new LocalFileStorage(`${config.fileStorageRoot}/media`),
            channelMedia,
          ),
        upgradeOriginals: (db) =>
          upgradeChannelImageOriginals(
            db,
            new LocalFileStorage(`${config.fileStorageRoot}/media`),
            channelMedia,
          ),
      });
      const stopChannelHostContactPoller = startChannelContactPoller({
        db: postgres.db,
        source: channelContacts,
        logger,
        intervalMs: 60_000,
        syncContacts: syncChannelContactProfiles,
      });
      // Solution 自动升级轮询已随平台化拆除（R3）删除。
      return async () => {
        stopMobileHandoffMaintenance();
        stopChannelHostPoller();
        stopChannelHostOutboundPoller();
        stopChannelHostMediaPoller();
        stopChannelHostContactPoller();
        stopAgentTurnDispatcher();
        stopMemoryCaptureDispatcher();
        stopTurnAdmissionDispatcher();
        stopScheduledSendDispatcher();
        stopMemoryMaintenance();
        stopMediaProcessingDispatcher();
        stopPushDispatcher();
        stopConversationEventBus();
        await channelKernel.stop();
      };
    }
    logger.info(
      "Channel Host is not configured; background channel polling is disabled",
    );
    return async () => {
      stopMobileHandoffMaintenance();
      stopAgentTurnDispatcher();
      stopMemoryCaptureDispatcher();
      stopTurnAdmissionDispatcher();
      stopScheduledSendDispatcher();
      stopMemoryMaintenance();
      stopMediaProcessingDispatcher();
      stopPushDispatcher();
      stopConversationEventBus();
    };
  },
});
