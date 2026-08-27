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
import { discoverAgentPlugins } from "../../infrastructure/solutions/agent-plugin-discovery.js";
import { readModelSettingsRuntime } from "../../modules/operations/application/model-settings.js";
import {
  classifyForTriage,
  extractTriagePolicy,
} from "../../modules/agent/application/triage-classifier.js";
import {
  createCachedExtensionSettingsReader,
} from "../../modules/solution/application/read-extension-settings.js";
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
    // 修改后需重启 worker 生效（启动时读取一次）。
    const modelSettings = await readModelSettingsRuntime(postgres.db, {
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
    });
    const model = {
      ...config.model,
      baseUrl: modelSettings.textModel.baseUrl,
      ...(modelSettings.textModel.apiKey !== undefined
        ? { apiKey: modelSettings.textModel.apiKey }
        : {}),
      name: modelSettings.textModel.name as typeof config.model.name,
    };
    // 创建 OpenAI 兼容的 LLM 客户端
    const client = new OpenAiCompatibleClient({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.name,
      timeoutMs: model.timeoutMs,
    });

    // Triage 预判分流：策略来自客服 Solution 的扩展设置（30s 缓存），
    // 未安装/未配置时回落默认策略（enabled=false → 整层短路，零行为变化）。
    // 模型槽位启动时读取一次（DB 可覆盖 env）；改动模型设置需重启 worker。
    const readPipelineSettings = createCachedExtensionSettingsReader(
      postgres.db,
      { solutionId: "weflow.customer-support", extensionId: "support-pipeline" },
    );
    const triageClient =
      config.triage && modelSettings.triageModel
        ? new OpenAiCompatibleClient({
            baseUrl: modelSettings.triageModel.baseUrl,
            apiKey: modelSettings.triageModel.apiKey ?? "",
            model: modelSettings.triageModel.name,
            timeoutMs: config.triage.timeoutMs,
          })
        : undefined;
    const fastClient =
      config.fast && modelSettings.fastModel
        ? new OpenAiCompatibleClient({
            baseUrl: modelSettings.fastModel.baseUrl,
            apiKey: modelSettings.fastModel.apiKey ?? "",
            model: modelSettings.fastModel.name,
            timeoutMs: config.fast.timeoutMs,
          })
        : undefined;
    const fastModelName = modelSettings.fastModel?.name;
    if (!triageClient) {
      logger.info("Triage classifier disabled (no model endpoint configured)");
    }
    // 可选的 WeKnora 知识库客户端
    const weknora = config.weknora
      ? new WeKnoraKnowledgeClient(config.weknora)
      : undefined;
    const kernel = new RuntimeKernel();
    kernel.register(openAiTextModelPlugin(client));
    if (weknora) kernel.register(weknoraKnowledgePlugin(weknora));
    // 记忆插件（D6 插件化下沉）：capture/recall 能力经 kernel 注册
    kernel.register(
      memoryPlugin({
        db: postgres.db,
        modelClient: client,
        model: model.name,
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
    // otherwise plugins are discovered from the Solution Store's active
    // junctions (manifest artifacts with targetProcess: "agent-worker").
    type AgentPluginModule = {
      skill?: AgentSkill;
      strategy?: AgentExecutionStrategy;
      createStrategy?: (ctx: { db: unknown }) => AgentExecutionStrategy;
      preResolveAiEmployeePrompt?: (
        db: unknown,
        contactId: string,
        conversationId: string,
      ) => Promise<void>;
    };
    const skillRegistry = new MapSkillRegistry();
    const strategyRegistry = new MapExecutionStrategyRegistry();
    // Optional pre-resolve hook for AI employee prompt resolution.
    let preResolveAiEmployeePrompt:
      | ((contactId: string, conversationId: string) => Promise<void>)
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
        preResolveAiEmployeePrompt = (contactId, conversationId) =>
          module.preResolveAiEmployeePrompt!(
            postgres.db,
            contactId,
            conversationId,
          );
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
          // 切换模型无需重启；实际使用模型写入 agentTurns.model 供核对
          const runtime = await readRuntimeSettings(postgres.db);
          const activeModel = runtime.textModel;
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
              ...(triageClient
                ? {
                    triage: {
                      classify: async (
                        context: {
                          triggerText: string;
                          recentInboundTexts: string[];
                        },
                      ) =>
                        classifyForTriage({
                          policy: extractTriagePolicy(
                            await readPipelineSettings(),
                          ),
                          client: triageClient,
                          ...(modelSettings.triageModel
                            ? { model: modelSettings.triageModel.name }
                            : {}),
                          triggerText: context.triggerText,
                          recentInboundTexts: context.recentInboundTexts,
                        }),
                      ...(fastClient && fastModelName
                        ? { fastClient, fastModel: fastModelName }
                        : {}),
                    },
                  }
                : {}),
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
        model: model.name,
        concurrency: config.agentWorkerConcurrency,
        memoryConcurrency: config.memoryCaptureConcurrency,
      },
      "Agent Worker started",
    );
    return async () => {
      await Promise.all([worker.close(), memoryWorker.close()]);
      await kernel.stop();
    };
  },
});
