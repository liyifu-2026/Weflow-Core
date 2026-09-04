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
import { and, eq } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { runProcess } from "../../infrastructure/runtime/run-process.js";
import { OpenAiCompatibleClient } from "../../infrastructure/model_runtime/openai-compatible-client.js";
import { HotReloadableClient } from "../../infrastructure/model_runtime/hot-reloadable-client.js";
import {
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
import { WeKnoraKnowledgeClient } from "../../infrastructure/knowledge/weknora-knowledge-client.js";
import { RuntimeKernel } from "../../infrastructure/runtime/kernel/index.js";
import { KNOWLEDGE_SEARCH_CAPABILITY } from "../../infrastructure/runtime/capabilities/knowledge-search.js";
import { TEXT_MODEL_CAPABILITY } from "../../infrastructure/runtime/capabilities/text-model.js";
import { weknoraKnowledgePlugin } from "../../infrastructure/knowledge/weknora-knowledge-provider.js";
import { readRuntimeSettings } from "../../modules/operations/application/runtime-settings.js";
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
    // 如果未配置模型运行时，Worker 进入空闲状态
    if (!config.model) {
      logger.warn("Model Runtime is not configured; Agent Worker is idle");
      return () => undefined;
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

    /**
     * 模型网关（R2）：按 text 槽位从注册表解析故障转移链。
     * 绑定了启用模型时返回 [主 → failoverTo] 运行时链（含密钥，
     * 仅进程内使用）；未绑定/读取失败返回 undefined（回退旧配置）。
     */
    const resolveTextChain = async (): Promise<FailoverLink[] | undefined> => {
      try {
        const endpoints = await resolveSlotChainRuntime(postgres.db, "text");
        if (endpoints.length === 0) return undefined;
        return endpoints.map((endpoint) => ({
          modelId: endpoint.modelId,
          displayName: endpoint.displayName,
          client: new OpenAiCompatibleClient({
            baseUrl: endpoint.baseUrl,
            apiKey: endpoint.apiKey ?? "",
            model: endpoint.displayName,
            timeoutMs: endpoint.timeoutMs,
          }),
        }));
      } catch (error) {
        logger.warn(
          { err: error },
          "model gateway chain resolution failed; falling back to legacy model settings",
        );
        return undefined;
      }
    };

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
      if (chain) {
        try {
          hotTextClient.swap(
            new FailoverTextModel(chain) as unknown as OpenAiCompatibleClient,
          );
          logger.info(
            { chain: chain.map((l) => l.modelId) },
            "model gateway failover chain applied",
          );
        } catch (error) {
          logger.warn({ err: error }, "failover chain apply failed");
        }
      }
    };
    void applyGatewayChain();
    const stopModelSettingsReloader = startModelSettingsReloader(
      postgres.db,
      modelDefaults,
      modelSettings,
      (settings) => {
        applyModelSettings(settings);
        void applyGatewayChain();
      },
    );

    if (!triageEndpoint) {
      logger.info("Triage classifier disabled (no model endpoint configured)");
    }
    // 可选的 WeKnora 知识库客户端
    const weknora = config.weknora
      ? new WeKnoraKnowledgeClient(config.weknora)
      : undefined;
    const kernel = new RuntimeKernel();
    kernel.register(openAiTextModelPlugin(hotTextClient));
    if (weknora) kernel.register(weknoraKnowledgePlugin(weknora));
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
    const knowledgeSearch = weknora
      ? kernel.get(KNOWLEDGE_SEARCH_CAPABILITY)
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
      createStrategy?: (ctx: { db: unknown }) => AgentExecutionStrategy;
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
    const registerAgentPluginModule = (
      module: AgentPluginModule,
      source: string,
    ) => {
      if (module.skill) {
        skillRegistry.register(module.skill);
      }
      // Prefer factory-created strategy (has database access for AI employee prompts)
      if (module.createStrategy) {
        strategyRegistry.register(module.createStrategy({ db: postgres.db }));
      } else if (module.strategy) {
        strategyRegistry.register(module.strategy);
      }
      if (module.preResolveAiEmployeePrompt) {
        preResolveAiEmployeePrompt = (contactId, conversationId, triggerText) =>
          module.preResolveAiEmployeePrompt!(
            postgres.db,
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
          // 运行时模型选择：每次消费读 runtime_settings（10s 缓存），
          // 切换模型无需重启；实际使用模型写入 agentTurns.model 供核对。
          // 连接端点（baseUrl/apiKey/槽位）同样热加载：Executor 每次
          // 构建时快照最新客户端，保存模型设置后无需重启。
          const runtime = await readRuntimeSettings(postgres.db);
          const activeModel = runtime.textModel;
          const triage = buildTriageDeps();
          const executor = new AgentTurnExecutor(
            postgres.db,
            textModel,
            activeModel,
            {
              knowledgeSearch,
              skillRegistry,
              strategyRegistry,
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
      await Promise.all([worker.close(), memoryWorker.close()]);
      await kernel.stop();
    };
  },
});
