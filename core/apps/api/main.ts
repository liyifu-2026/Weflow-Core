/**
 * Weflow Core API 入口
 *
 * 职责：
 * - 注册所有业务模块的 HTTP API 路由（身份、对话、联系人、内存、媒体、代理等）
 * - 启动 Redis 消息队列调度器（Agent Turn、内存捕获、媒体处理、推送通知）
 * - 启动 Channel Host 轮询器，从 Channel Host 同步通道事件
 */
import { resolve } from "node:path";
import { runProcess } from "../../infrastructure/runtime/run-process.js";
import multipart from "@fastify/multipart";
import { LocalFileStorage } from "../../infrastructure/file_storage/local-file-storage.js";
import { registerCors } from "../../infrastructure/http/cors.js";
import { startAgentTurnDispatcher } from "../../infrastructure/redis/agent-turn-dispatcher.js";
import { startMemoryCaptureDispatcher } from "../../infrastructure/redis/memory-capture-dispatcher.js";
import { startMediaProcessingDispatcher } from "../../infrastructure/redis/media-processing-dispatcher.js";
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
import { registerHandoffRoutes } from "../../modules/handoff/interface/http-routes.js";
import { registerIdentityRoutes } from "../../modules/identity/interface/http-routes.js";
import { registerContactProfileRoutes } from "../../modules/contacts/interface/http-routes.js";
import { registerContactAvatarRoutes } from "../../modules/contacts/interface/avatar-routes.js";
import { AvatarProxyService } from "../../modules/contacts/application/avatar-proxy-service.js";
import { registerMemoryRoutes } from "../../modules/memory/interface/http-routes.js";
import { registerMediaRoutes } from "../../modules/media/interface/http-routes.js";
import { registerNotificationRoutes } from "../../modules/notifications/interface/http-routes.js";
import { registerCollaborationRoutes } from "../../modules/collaboration/interface/http-routes.js";
import { registerKnowledgeRoutes } from "../../modules/knowledge/interface/http-routes.js";
import { OpenAiCompatibleClient } from "../../infrastructure/model_runtime/openai-compatible-client.js";
import { WeKnoraKnowledgeClient } from "../../infrastructure/knowledge/weknora-knowledge-client.js";
import { startExpoPushDispatcher } from "../../infrastructure/notifications/expo-push-dispatcher.js";
import { registerKnowledgeProviderRoutes } from "../../modules/knowledge-provider/interface/http-routes.js";
import { registerKnoraBridgeRoutes } from "../../modules/knora-bridge/interface/http-routes.js";
import { registerOperationsRoutes } from "../../modules/operations/interface/http-routes.js";
import { registerSolutionRoutes } from "../../modules/solution/interface/http-routes.js";
import { registerSolutionRunnerRoutes } from "../../modules/solution/interface/runner-routes.js";
import { startPluginEventDispatcher } from "../../modules/solution/application/plugin-event-dispatcher.js";
import { registerSolutionBackendPlugins } from "../../modules/solution/application/solution-backend-loader.js";
import { requireBusinessIdentity } from "../../modules/identity/interface/request-authentication.js";
import { inspectKnowledgeEngine } from "../../modules/knowledge-provider/application/boundary.js";
import { startMobileHandoffMaintenance } from "../../modules/handoff/application/mobile-handoff-service.js";
import { routeMediaToHuman } from "../../modules/handoff/application/route-media-to-human.js";
import { readRuntimeSettings } from "../../modules/operations/application/runtime-settings.js";
import {
  currentChannelCursor,
  ingestChannelEvents,
} from "../../modules/conversations/application/ingest-channel-events.js";
import { processOutboundMessages } from "../../modules/conversations/application/process-outbound-messages.js";
import { syncChannelImages } from "../../modules/media/application/sync-channel-images.js";
import { syncChannelContactProfiles } from "../../modules/contacts/application/sync-channel-contact-profiles.js";

/** 启动 Core API 进程 */
await runProcess({
  name: "core-api",
  healthPort: (config) => config.corePort,
  /** 配置 HTTP 服务器，注册所有业务模块的路由 */
  configureServer: async (server, { config, postgres }) => {
    registerCors(server, config.corsOrigins);
    await server.register(multipart, {
      limits: { fileSize: 100 * 1_024 * 1_024, files: 1 },
    });
    registerIdentityRoutes(
      server,
      postgres.db,
      new LocalFileStorage(`${config.fileStorageRoot}/identity`),
    );
    registerConversationRoutes(server, postgres.db);
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
    registerMediaRoutes(server, postgres.db, `${config.fileStorageRoot}/media`);
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
    });
    registerOperationsRoutes(server, postgres.db, {
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
    });
    const solutionStagingRoot =
      process.env.SOLUTION_STAGING_ROOT ??
      resolve(config.fileStorageRoot, "solution-staging");
    registerSolutionRoutes(server, postgres.db, {
      stagingRoot: solutionStagingRoot,
    });
    registerSolutionRunnerRoutes(server, postgres.db);
    await registerSolutionBackendPlugins(
      server,
      postgres.db,
      solutionStagingRoot,
      {
        knowledgeClient,
      },
      requireBusinessIdentity,
    );
  },
  /** 启动后台调度器和正式 Channel Host 轮询器，返回清理函数 */
  start: async ({ config, logger, postgres }) => {
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
    // 启动媒体处理调度器，处理入站媒体文件的转码和存储。
    // 业务依赖由组合根绑定：infrastructure 的 dispatcher/poller 不反向依赖 modules。
    const stopMediaProcessingDispatcher = startMediaProcessingDispatcher({
      db: postgres.db,
      redisUrl: config.redisUrl,
      logger,
      visionConfigured: Boolean(config.vision),
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
    const stopPluginEvents = startPluginEventDispatcher(postgres.db);
    if (config.channelHost && channelKernel) {
      const channelSource = channelKernel.get(CHANNEL_EVENTS_CAPABILITY);
      const channelMedia = channelKernel.get(CHANNEL_MEDIA_CAPABILITY);
      const channelSendOperations = channelKernel.get(CHANNEL_SEND_CAPABILITY);
      const channelContacts = channelKernel.get(CHANNEL_CONTACTS_CAPABILITY);
      const stopChannelHostPoller = startChannelEventPoller({
        source: channelSource,
        db: postgres.db,
        logger,
        intervalMs: config.channelHost.pollIntervalMs,
        dependencies: {
          currentCursor: (db) =>
            currentChannelCursor(db, "channel-host").then(String),
          ingestEvents: (db, events, nextCursor) =>
            ingestChannelEvents(db, events, nextCursor, logger),
        },
      });
      const stopChannelHostOutboundPoller = startChannelOutboundPoller({
        db: postgres.db,
        logger,
        intervalMs: config.channelHost.pollIntervalMs,
        sendOutbound: (db) =>
          processOutboundMessages(db, channelSendOperations),
      });
      const stopChannelHostMediaPoller = startChannelMediaPoller({
        db: postgres.db,
        logger,
        intervalMs: config.channelHost.pollIntervalMs,
        syncMedia: (db) =>
          syncChannelImages(
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
      return async () => {
        stopMobileHandoffMaintenance();
        stopChannelHostPoller();
        stopChannelHostOutboundPoller();
        stopChannelHostMediaPoller();
        stopChannelHostContactPoller();
        stopAgentTurnDispatcher();
        stopMemoryCaptureDispatcher();
        stopMediaProcessingDispatcher();
        stopPushDispatcher();
        stopPluginEvents();
        await channelKernel.stop();
      };
    }
    logger.info(
      "Channel Host is not configured; background channel polling is disabled",
    );
    return () => {
      stopMobileHandoffMaintenance();
      stopAgentTurnDispatcher();
      stopMemoryCaptureDispatcher();
      stopMediaProcessingDispatcher();
      stopPushDispatcher();
      stopPluginEvents();
    };
  },
});
