export type RuntimeCapabilities = {
  channelHostConfigured: boolean;
  modelConfigured: boolean;
  knowledgeConfigured: boolean;
  inspectKnowledge?: () => Promise<{
    checkedAt: string;
    status: "ready" | "degraded" | "not_configured";
    components: Array<{
      key: string;
      name: string;
      status: "ready" | "unavailable" | "not_configured";
      summary: string;
    }>;
  }>;
  inspectChannelHost?: () => Promise<{
    status: "healthy" | "unreachable" | "not_configured";
    summary: string;
  }>;
  inspectModel?: () => Promise<{
    status: "healthy" | "unreachable" | "not_configured";
    summary: string;
  }>;
};

export async function buildSystemStatus(capabilities: RuntimeCapabilities) {
  const [knowledge, channelHost, model] = await Promise.all([
    capabilities.inspectKnowledge
      ? capabilities.inspectKnowledge()
      : Promise.resolve({
          checkedAt: new Date().toISOString(),
          status: "not_configured" as const,
          components: [],
        }),
    capabilities.inspectChannelHost
      ? capabilities.inspectChannelHost()
      : Promise.resolve({
          status: "not_configured" as const,
          summary: "未提供实时业务探测",
        }),
    capabilities.inspectModel
      ? capabilities.inspectModel()
      : Promise.resolve({
          status: "not_configured" as const,
          summary: "未提供实时业务探测",
        }),
  ]);
  const configuration = (configured: boolean) => ({
    status: configured ? ("configured" as const) : ("not_configured" as const),
    summary: configured ? "已配置" : "尚未配置",
  });
  const health = (
    state: "healthy" | "unreachable" | "not_configured",
    summary: string,
  ) => ({
    status: state === "not_configured" ? ("not_monitored" as const) : state,
    summary,
  });
  return {
    checkedAt: knowledge.checkedAt,
    services: [
      {
        key: "core",
        name: "Weflow Core",
        configuration: configuration(true),
        health: {
          status: "healthy" as const,
          summary: "Core API 运行中",
        },
      },
      {
        key: "channel-host",
        name: "Channel Host",
        configuration: configuration(capabilities.channelHostConfigured),
        health: health(channelHost.status, channelHost.summary),
      },
      {
        key: "model",
        name: "模型运行时",
        configuration: configuration(capabilities.modelConfigured),
        health: health(model.status, model.summary),
      },
      {
        key: "knowledge",
        name: "知识服务",
        configuration: configuration(capabilities.knowledgeConfigured),
        health:
          knowledge.status === "ready"
            ? { status: "healthy" as const, summary: "服务可访问" }
            : knowledge.status === "degraded"
              ? { status: "unreachable" as const, summary: "服务当前不可访问" }
              : {
                  status: "not_monitored" as const,
                  summary: "未配置，无法探测",
                },
        details: knowledge.components,
      },
    ],
  };
}
