/**
 * Agent Worker 进程入口
 *
 * 职责：
 * - 从 Redis 队列消费 Agent Turn 任务，调用 LLM 模型处理对话轮次
 * - 从 Redis 队列消费内存捕获任务，异步提取和持久化对话记忆
 * - 使用 ConversationTurnExecutor 保证同一对话内的轮次串行执行
 * - 处理任务失败和重试耗尽场景，触发 Agent Handoff 降级
 */
import { Worker } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { runProcess } from "../../infrastructure/runtime/run-process.js";
import { startConversationEventBus } from "../../infrastructure/events/conversation-events.js";
import { OpenAiCompatibleClient } from "../../infrastructure/model_runtime/openai-compatible-client.js";
import { LocalFileStorage } from "../../infrastructure/file_storage/local-file-storage.js";
import { HotReloadableClient } from "../../infrastructure/model_runtime/hot-reloadable-client.js";
import {
  buildTextFailoverChain,
  resolvePrimaryTextModelName,
  resolveSlotChainRuntime,
} from "../../modules/operations/application/model-gateway.js";
import {
  FailoverTextModel,
  type FailoverLink,
} from "../../modules/operations/application/model-failover.js";
import { openAiTextModelPlugin } from "../../infrastructure/model/openai-text-model-provider.js";
import { AGENT_TURN_QUEUE } from "../../infrastructure/redis/agent-turn-dispatcher.js";
import {
  bullMqConnection,
  type JobEnvelope,
} from "../../infrastructure/redis/job-queue.js";
import {
  AgentTurnExecutor,
  getAgentTurnConversationId,
} from "../../modules/agent/application/agent-turn-executor.js";
import { reconcileAgentTurnQueueFailure } from "../../modules/agent/application/agent-turn-failure-coordinator.js";
import { ConversationTurnExecutor } from "../../modules/agent/application/conversation-turn-executor.js";
import {
  MEMORY_CAPTURE_QUEUE,
  memoryCaptureRevision,
} from "../../infrastructure/redis/memory-capture-dispatcher.js";
import { memoryPlugin } from "../../infrastructure/runtime/plugins/memory-plugin.js";
import { MEMORY_CAPTURE_CAPABILITY } from "../../infrastructure/runtime/capabilities/memory.js";
import * as schema from "../../infrastructure/postgres/schema.js";
import { RuntimeKernel } from "../../infrastructure/runtime/kernel/index.js";
import { KNOWLEDGE_SEARCH_CAPABILITY } from "../../infrastructure/runtime/capabilities/knowledge-search.js";
import { TEXT_MODEL_CAPABILITY } from "../../infrastructure/runtime/capabilities/text-model.js";
import { weknoraKnowledgePlugin } from "../../infrastructure/knowledge/weknora-knowledge-provider.js";
import { createAdaptiveKnowledgeClient } from "../../infrastructure/knowledge/knowledge-connector-settings.js";
import { createCircuitBreakerKnowledgeSearch } from "../../infrastructure/knowledge/knowledge-circuit-breaker.js";
import { startModelSettingsReloader } from "../../modules/operations/application/model-settings-hot.js";
import { discoverAgentPlugins } from "../../infrastructure/solutions/agent-plugin-discovery.js";
import { readModelSettingsRuntime } from "../../modules/operations/application/model-settings.js";
import {
  classifyForTriage,
  extractTriagePolicy,
} from "../../modules/agent/application/triage-classifier.js";
import { createBehaviorSettingsReader } from "../../modules/agent/application/behavior-settings.js";
import { createCachedExtensionSettingsReader } from "../../infrastructure/settings/extension-settings.js";
import {
  MapSkillRegistry,
  type AgentSkill,
} from "../../modules/agent/contracts/agent-skill.js";
import {
  MapExecutionStrategyRegistry,
  type AgentExecutionStrategy,
} from "../../modules/agent/contracts/execution-strategy.js";

await runProcess({
  name: "agent-worker",
  healthPort: (config) => config.agentWorkerHealthPort,
  start: async ({ config, logger, postgres }) => {
    // 跨进程事件总线（只发布）：本进程产出的 Agent 回复消息必须广播给
    // api 进程，才能经 SSE 即时到达工作台，而不是等 Channel Host 回采。
    const stopConversationEventBus = startConversationEventBus({
      redisUrl: config.redisUrl,
      logger,
      subscribe: false,
    });
    // 如果未配置模型运行时，Worker 进入空闲状态
    if (!config.model) {
      logger.warn("Model Runtime is not configured; Agent Worker is idle");
      return () => {
        stopConversationEventBus();
      };
    }
    // 平台大模型设置（Operator Control Plane）：DB 覆盖 env 默认值。
    // 热加载：Console 保存后即时生效，无需重启 worker（见 model-settings-hot）。
    const modelDefaults = {
      textModel: {
        name: config.model.name,
        baseUrl: config.model.baseUrl,
        ...(config.model.apiKey !== undefined
          ? { apiKey: config.model.apiKey }
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
    };
    const modelSettings = await readModelSettingsRuntime(
      postgres.db,
      modelDefaults,
    );
    // 闭包内使用的常量：避免 apply 回调中 TS 对 config.model 收窄丢失。
    const textTimeoutMs = config.model.timeoutMs;

    // 可热更新的主力模型客户端：swap 原子替换快照，飞行中请求用旧实例完成。
    const hotTextClient = new HotReloadableClient(
      new OpenAiCompatibleClient({
        baseUrl: modelSettings.textModel.baseUrl,
        apiKey: modelSettings.textModel.apiKey ?? "",
        model: modelSettings.textModel.name,
        timeoutMs: textTimeoutMs,
        maxTokens: config.model?.maxTokens,
      }),
    );

    // Triage 预判分流：策略来自客服 Solution 的扩展设置（30s 缓存），
    // 未安装/未配置时回落默认策略（enabled=false → 整层短路，零行为变化）。
    // 模型槽位随热加载更新：triage/fast 客户端与传给 classifyForTriage 的
    // 模型名在每次设置变化时重建/刷新，无需重启 worker。
    const readPipelineSettings = createCachedExtensionSettingsReader(
      postgres.db,
      {
        solutionId: "weflow.customer-support",
        extensionId: "support-pipeline",
      },
    );
    // 行为参数（R2 设置中心）：会话 TTL/轮数/wait 缺省/ReAct 预算，
    // 存于 Solution 扩展设置 behavior 键；未配置时逐项回落出厂默认。
    const readBehaviorSettings = createBehaviorSettingsReader(postgres.db, {
      solutionId: "weflow.customer-support",
      extensionId: "support-pipeline",
    });
    // 当前生效的分流/直答端点快照（applyModelSettings 内整体替换）。
    let triageEndpoint:
      { client: OpenAiCompatibleClient; model: string } | undefined;
    let fastEndpoint:
      { client: OpenAiCompatibleClient; model: string } | undefined;
    // 记忆提取引用的模型名快照（随热加载刷新，经闭包读取最新值）。
    let memoryModelName = modelSettings.textModel.name;
    // 旧配置回落名快照：text 槽位未绑定/解析失败时，主模型名回落到
    // model-settings 组（DB model_name → env MODEL_NAME 引导默认）。
    // 仅作启动兜底，槽位绑定后此值不参与任何请求。
    let legacyTextModelName = modelSettings.textModel.name;

    /**
     * 模型网关（R2）：按 text 槽位从注册表解析故障转移链。
     * 链解析策略在 model-gateway（buildTextFailoverChain，可注入客户端
     * 工厂单测）；此处仅绑定本进程的客户端构造与日志。
     */
    const resolveTextChain = async (): Promise<FailoverLink[] | undefined> =>
      buildTextFailoverChain(postgres.db, {
        clientFactory: (endpoint) =>
          new OpenAiCompatibleClient({
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey ?? "",
            model: endpoint.displayName,
            timeoutMs: endpoint.timeoutMs,
          }),
        logger,
      });

    /** 按最新模型设置重建/替换所有派生客户端（热加载核心）。 */
    const applyModelSettings = (settings: typeof modelSettings): void => {
      hotTextClient.swap(
        new OpenAiCompatibleClient({
          baseUrl: settings.textModel.baseUrl,
          apiKey: settings.textModel.apiKey ?? "",
          model: settings.textModel.name,
          timeoutMs: textTimeoutMs,
        }),
      );
      memoryModelName = settings.textModel.name;
      legacyTextModelName = settings.textModel.name;
      triageEndpoint = settings.triageModel
        ? {
            client: new OpenAiCompatibleClient({
              baseUrl: settings.triageModel.baseUrl,
              apiKey: settings.triageModel.apiKey ?? "",
              model: settings.triageModel.name,
              timeoutMs: config.triage?.timeoutMs ?? 3_000,
            }),
            model: settings.triageModel.name,
          }
        : undefined;
      fastEndpoint = settings.fastModel
        ? {
            client: new OpenAiCompatibleClient({
              baseUrl: settings.fastModel.baseUrl,
              apiKey: settings.fastModel.apiKey ?? "",
              model: settings.fastModel.name,
              timeoutMs: config.fast?.timeoutMs ?? 3_000,
            }),
            model: settings.fastModel.name,
          }
        : undefined;
      logger.info(
        {
          textModel: settings.textModel.name,
          triageModel: settings.triageModel?.name ?? "(none)",
          fastModel: settings.fastModel?.name ?? "(none)",
        },
        "model settings hot-reloaded",
      );
    };
    applyModelSettings(modelSettings);
    // 模型网关（R2）：text 槽位绑定注册表模型时，主力客户端切换为
    // 故障转移链；未绑定/解析失败回退旧 model-settings 单端点。
    // 链解析异步，随热加载轮询刷新。
    const applyGatewayChain = async (): Promise<void> => {
      const chain = await resolveTextChain();
      const primaryLink = chain?.[0];
      if (chain && primaryLink) {
        try {
          hotTextClient.swap(
            new FailoverTextModel(chain) as unknown as OpenAiCompatibleClient,
          );
          // 主模型名对齐链主端点：记忆提取与 turn 元数据记录的名字
          // 必须与实际请求模型一致（配置收敛：槽位是唯一事实源）。
          memoryModelName = primaryLink.displayName;
          logger.info(
            {
              chain: chain.map((l) => l.modelId),
              primary: primaryLink.displayName,
            },
            "model gateway failover chain applied (primary text model from slot)",
          );
        } catch (error) {
          logger.warn({ err: error }, "failover chain apply failed");
        }
      }
    };
    void applyGatewayChain();
    // triage/fast 槽位接线（配置收敛）：分流/直答端点同 text 槽位一样
    // 以 model_slot_* 绑定为唯一事实源；applyModelSettings 先落
    // model-settings 组旧值，槽位绑定在此覆盖。随热加载轮询刷新。
    const applySlotEndpoints = async (): Promise<void> => {
      const resolveEndpoint = async (slot: "triage" | "fast") => {
        try {
          const chain = await resolveSlotChainRuntime(postgres.db, slot);
          return chain[0];
        } catch (error) {
          logger.warn(
            { err: error, slot },
            "model gateway slot endpoint resolution failed; keeping legacy settings",
          );
          return undefined;
        }
      };
      const [triageEndpointSlot, fastEndpointSlot] = await Promise.all([
        resolveEndpoint("triage"),
        resolveEndpoint("fast"),
      ]);
      if (triageEndpointSlot) {
        triageEndpoint = {
          client: new OpenAiCompatibleClient({
            baseUrl: triageEndpointSlot.baseUrl,
            apiKey: triageEndpointSlot.apiKey ?? "",
            model: triageEndpointSlot.displayName,
            timeoutMs: config.triage?.timeoutMs ?? 3_000,
          }),
          model: triageEndpointSlot.displayName,
        };
      }
      if (fastEndpointSlot) {
        fastEndpoint = {
          client: new OpenAiCompatibleClient({
            baseUrl: fastEndpointSlot.baseUrl,
            apiKey: fastEndpointSlot.apiKey ?? "",
            model: fastEndpointSlot.displayName,
            timeoutMs: config.fast?.timeoutMs ?? 3_000,
          }),
          model: fastEndpointSlot.displayName,
        };
      }
      if (triageEndpointSlot || fastEndpointSlot) {
        logger.info(
          {
            triage: triageEndpointSlot?.displayName ?? "(legacy/none)",
            fast: fastEndpointSlot?.displayName ?? "(legacy/none)",
          },
          "model gateway slot endpoints applied (triage/fast)",
        );
      }
    };
    void applySlotEndpoints();
    const stopModelSettingsReloader = startModelSettingsReloader(
      postgres.db,
      modelDefaults,
      modelSettings,
      (settings) => {
        applyModelSettings(settings);
        void applyGatewayChain();
        void applySlotEndpoints();
      },
    );

    if (!triageEndpoint) {
      logger.info("Triage classifier disabled (no model endpoint configured)");
    }
    // 知识库客户端（ADR-0008）：设置中心连接器优先、env 兜底，30s 热加载。
    // 客户端恒注册；未配置时检索抛 weknora_not_configured（与缺能力同码）。
    const knowledge = await createAdaptiveKnowledgeClient(
      postgres.db,
      config.weknora ?? undefined,
    );
    const kernel = new RuntimeKernel();
    kernel.register(openAiTextModelPlugin(hotTextClient));
    kernel.register(weknoraKnowledgePlugin(knowledge.client));
    // 记忆插件（D6 插件化下沉）：capture/recall 能力经 kernel 注册；
    // 模型名经 getter 随热加载刷新（记忆请求同时应用 baseUrl/apiKey/模型名）。
    kernel.register(
      memoryPlugin({
        db: postgres.db,
        modelClient: hotTextClient,
        model: () => memoryModelName,
      }),
    );
    await kernel.start();
    const textModel = kernel.get(TEXT_MODEL_CAPABILITY);
    const memoryCapture = kernel.get(MEMORY_CAPTURE_CAPABILITY);
    const knowledgeCapability = kernel.get(KNOWLEDGE_SEARCH_CAPABILITY);
    // 熔断器（L1 反编造层）：检索连续失败达到阈值后 open——knowledgeSearch
    // 闭包撤下 retrieve_knowledge，提示词随之切换「知识库不可用」，保持
    // 能力宣传 = 运行时现实；冷却期满 half-open 放行一次探测自动恢复。
    const knowledgeBreaker = createCircuitBreakerKnowledgeSearch(
      knowledgeCapability,
      logger,
    );
    // 未配置时不下发 retrieve_knowledge 工具（提示词/工具列表随 30s 快照联动），
    // 保持「配置了才可见」的既有语义；配置后生效延迟 ≤ 轮询间隔。
    // 熔断 open 时同样撤下（每次取用读当下状态，恢复无需重启）。
    const knowledgeSearch = () =>
      knowledge.currentOptions() && !knowledgeBreaker.isOpen()
        ? knowledgeBreaker
        : undefined;
    // Skill / Execution Strategy registries: populated from Solution plugins.
    // Module contract: `skill` (an AgentSkill), and/or `strategy` (an
    // AgentExecutionStrategy), `createStrategy` (factory receiving { db } so
    // the strategy gets database access for AI employee prompt resolution),
    // plus optional `preResolveAiEmployeePrompt`. Without any plugin, the
    // registries stay empty and the built-in generic platform prompt is used.
    // Priority: explicit SKILL_PLUGIN_PATH / STRATEGY_PLUGIN_PATH overrides;
    // otherwise plugins are discovered from WEFLOW_PLUGIN_DIR's plugins/
    // subdirectories (R3: no more Solution Store).
    type AgentPluginModule = {
      skill?: AgentSkill;
      strategy?: AgentExecutionStrategy;
      createStrategy?: (ctx: {
        db: unknown;
        /** drizzle sql 标签：插件执行参数化原生 SQL 用 */
        sql?: unknown;
      }) => AgentExecutionStrategy;
      preResolveAiEmployeePrompt?: (
        db: unknown,
        contactId: string,
        conversationId: string,
        triggerText?: string | undefined,
      ) => Promise<void>;
      /** 可选：读取 preResolve 阶段缓存的 AI 员工标识（用于消息头像） */
      getCachedAiEmployeeId?: (
        contactId: string,
        conversationId: string,
      ) => string | null | undefined;
    };
    const skillRegistry = new MapSkillRegistry();
    const strategyRegistry = new MapExecutionStrategyRegistry();
    // Optional pre-resolve hook for AI employee prompt resolution.
    let preResolveAiEmployeePrompt:
      | ((
          contactId: string,
          conversationId: string,
          triggerText?: string | undefined,
        ) => Promise<void>)
      | undefined;
    // Optional AI employee identity hook: preResolve 之后按会话读取员工标识，
    // 写入 agent 出站消息 actor_id，供各端渲染员工专属头像。
    let resolveAiEmployeeId:
      | ((contactId: string, conversationId: string) => Promise<string | null>)
      | undefined;
    // 插件数据库句柄：drizzle db + sql 标签打包注入。db.execute 只接受
    // SQLWrapper | string，插件必须经 sql 标签参数化，不能传 `{ sql, args }`。
    const pluginDb = {
      execute: postgres.db.execute.bind(postgres.db),
      sql,
    };
    const registerAgentPluginModule = (
      module: AgentPluginModule,
      source: string,
    ) => {
      if (module.skill) {
        skillRegistry.register(module.skill);
      }
      // Prefer factory-created strategy (has database access for AI employee prompts)
      if (module.createStrategy) {
        strategyRegistry.register(module.createStrategy({ db: pluginDb, sql }));
      } else if (module.strategy) {
        strategyRegistry.register(module.strategy);
      }
      if (module.preResolveAiEmployeePrompt) {
        preResolveAiEmployeePrompt = (contactId, conversationId, triggerText) =>
          module.preResolveAiEmployeePrompt!(
            pluginDb,
            contactId,
            conversationId,
            triggerText,
          );
      }
      if (module.getCachedAiEmployeeId && module.preResolveAiEmployeePrompt) {
        resolveAiEmployeeId = async (contactId, conversationId) =>
          module.getCachedAiEmployeeId!(contactId, conversationId) ?? null;
      }
      logger.info({ source }, "agent worker plugin loaded");
    };

    if (process.env.SKILL_PLUGIN_PATH || process.env.STRATEGY_PLUGIN_PATH) {
      const skillPath = process.env.SKILL_PLUGIN_PATH;
      if (skillPath) {
        registerAgentPluginModule(
          (await import(pathToFileURL(skillPath).href)) as AgentPluginModule,
          skillPath,
        );
      }
      const strategyPath = process.env.STRATEGY_PLUGIN_PATH;
      if (strategyPath) {
        registerAgentPluginModule(
          (await import(pathToFileURL(strategyPath).href)) as AgentPluginModule,
          strategyPath,
        );
      }
    } else {
      for (const found of await discoverAgentPlugins()) {
        if (!found.module) {
          logger.warn(
            { err: found.error, artifactId: found.artifactId },
            "agent worker plugin failed to load",
          );
          continue;
        }
        registerAgentPluginModule(found.module as AgentPluginModule, found.url);
      }
    }
    // 对话轮次执行器，确保同一对话的任务串行执行
    const conversationTurns = new ConversationTurnExecutor();
    /** 按 job 构建分流依赖：快照当前生效的 triage/fast 端点（热加载后即新值）。 */
    const buildTriageDeps = () => {
      const currentTriage = triageEndpoint;
      if (!currentTriage) return undefined;
      const currentFast = fastEndpoint;
      return {
        classify: async (context: {
          triggerText: string;
          recentInboundTexts: string[];
        }) =>
          classifyForTriage({
            policy: extractTriagePolicy(await readPipelineSettings()),
            client: currentTriage.client,
            model: currentTriage.model,
            triggerText: context.triggerText,
            recentInboundTexts: context.recentInboundTexts,
          }),
        ...(currentFast
          ? { fastClient: currentFast.client, fastModel: currentFast.model }
          : {}),
      };
    };
    // Agent Turn 工作队列消费者
    const worker = new Worker<JobEnvelope>(
      AGENT_TURN_QUEUE,
      async (job) => {
        const turnId = job.data.businessEntityId;
        // 获取该轮次所属的对话 ID
        const conversationId = await getAgentTurnConversationId(
          postgres.db,
          turnId,
        );
        // 进程内锁只是优化；AgentTurnExecutor 内的 CAS/ownership lock
        // 才是跨 Worker、跨实例的最终并发权威。
        await conversationTurns.run(conversationId, async () => {
          // 运行时模型选择（配置收敛：text 槽位是唯一事实源）：
          // 槽位绑定注册表模型时，activeModel 取链主端点 displayName——
          // 它既是 agentTurns.model 的记录名，也是决策请求的 modelId
          // （modelId 会覆盖链端点的模型名，两者必须一致）。未绑槽位
          // 回落 model-settings 引导值（DB model_name → env MODEL_NAME）。
          // 端点（baseUrl/apiKey）由 hotTextClient 网关链热加载。
          const primary = await resolvePrimaryTextModelName(
            postgres.db,
            legacyTextModelName,
          );
          const activeModel = primary.name;
          const triage = buildTriageDeps();
          // Phase 4 视觉直读：仅当 text 槽位主模型声明视觉能力时才注入
          // 媒体文件存储（把最新入站图片直接喂给主模型）。非视觉模型一律
          // 不注入，图片维持文本占位——避免把 image_url 喂给不支持图像的
          // 模型（400 会让轮次失败并再次触发降级转人工）。
          let imageStorage: LocalFileStorage | undefined;
          try {
            const textChain = await resolveSlotChainRuntime(
              postgres.db,
              "text",
            );
            if (textChain.some((e) => e.capabilities.includes("vision"))) {
              imageStorage = new LocalFileStorage(
                `${config.fileStorageRoot}/media`,
              );
            }
          } catch {
            imageStorage = undefined;
          }
          const executor = new AgentTurnExecutor(
            postgres.db,
            textModel,
            activeModel,
            {
              knowledgeSearch: knowledgeSearch(),
              skillRegistry,
              strategyRegistry,
              ...(imageStorage ? { imageStorage } : {}),
              ...(preResolveAiEmployeePrompt
                ? { preResolveAiEmployeePrompt }
                : {}),
              ...(resolveAiEmployeeId ? { resolveAiEmployeeId } : {}),
              ...(triage ? { triage } : {}),
              behaviorSettings: readBehaviorSettings,
              decisionTimeoutMs: config.model?.decisionTimeoutMs,
            },
          );
          await executor.execute({
            turnId,
            traceId: job.data.traceId,
          });
        });
      },
      {
        connection: bullMqConnection(config.redisUrl),
        concurrency: config.agentWorkerConcurrency,
      },
    );
    // 内存捕获工作队列消费者，异步提取对话中的记忆信息
    const memoryWorker = new Worker<JobEnvelope>(
      MEMORY_CAPTURE_QUEUE,
      async (job) => {
        const conversationId = job.data.businessEntityId;
        // 获取内存捕获的版本号，用于幂等处理
        const revision = memoryCaptureRevision(job.data);
        // 同样使用对话级别锁，避免与 Agent Turn 并发冲突
        await conversationTurns.run(conversationId, async () => {
          await memoryCapture.process(postgres.db, {
            conversationId,
            revision,
          });
        });
      },
      {
        connection: bullMqConnection(config.redisUrl),
        concurrency: config.memoryCaptureConcurrency,
      },
    );
    // Agent Turn 任务失败处理
    worker.on("failed", (job, error) => {
      logger.error(
        { err: error, jobId: job?.id },
        "Agent turn job attempt failed",
      );
      // 如果重试次数已耗尽，标记轮次为失败并触发 Handoff 降级
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        void reconcileAgentTurnQueueFailure(
          postgres.db,
          job.data.businessEntityId,
          "retry_exhausted",
        ).catch((databaseError: unknown) => {
          logger.error(
            { err: databaseError, jobId: job.id },
            "Failed to persist exhausted Agent turn",
          );
        });
      }
    });
    // 内存捕获任务失败处理
    memoryWorker.on("failed", (job, error) => {
      logger.error(
        { err: error, jobId: job?.id },
        "Memory capture job attempt failed",
      );
      // 重试耗尽后标记内存捕获状态为失败
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        const revision = memoryCaptureRevision(job.data);
        void postgres.db
          .update(schema.memoryCaptureStates)
          .set({ status: "failed", errorCode: "retry_exhausted" })
          .where(
            and(
              eq(
                schema.memoryCaptureStates.conversationId,
                job.data.businessEntityId,
              ),
              eq(schema.memoryCaptureStates.revision, revision),
            ),
          )
          .catch((databaseError: unknown) => {
            logger.error(
              { err: databaseError, jobId: job.id },
              "Failed to persist exhausted Memory capture",
            );
          });
      }
    });
    logger.info(
      {
        model: memoryModelName,
        concurrency: config.agentWorkerConcurrency,
        memoryConcurrency: config.memoryCaptureConcurrency,
      },
      "Agent Worker started",
    );
    return async () => {
      stopModelSettingsReloader();
      knowledge.stop();
      await Promise.all([worker.close(), memoryWorker.close()]);
      await kernel.stop();
      stopConversationEventBus();
    };
  },
});
