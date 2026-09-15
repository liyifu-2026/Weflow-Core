# ADR 0008：知识库配置统一（设置中心优先，.env 兜底，热加载）

- 状态：已接受（2026-09-05）
- 关联：ADR-0002（AI 客服闭环）、设置中心（R2）

## 背景

知识库（WeKnora）配置曾存在三份互不相通的来源——「阴阳配置」：

1. `core/.env` 的 `WEKNORA_*`：agent-worker / api 进程运行时唯一真用的；
2. 设置中心「知识库连接器」表单（support-pipeline 行 `knowledgeConnector`
   键）：R2 建好界面并提示「30 秒内生效」，但 Core 无任何消费方，是死配置；
   且设置页「读整行→写整行」模式存在丢失更新风险，已填内容可能被其他
   分区保存时抹掉；
3. 旧插件行 `weflow.weknora-connector / weknora-connector-settings`：
   R3 前遗留，无消费方。

## 决策

1. **设置中心为唯一界面入口，`.env` 降级为兜底**（ADR-0008，本次）。
   优先级：`knowledgeConnector`（weknora 预设且 retrieveUrl 非空）> env >
   未配置；界面字段缺省时逐项回落 env（如只填端点不填 key，沿用 env key）。
2. **解析规则**（`infrastructure/knowledge/knowledge-connector-settings.ts`）：
   - retrieveUrl 为检索端点（…/api/v1/knowledge-search），末尾
     `/knowledge-search` 剥离为客户端 baseUrl；
   - 认证：bearer → `Authorization: Bearer <authValue>`；header →
     `<authHeader>: <authValue>`；none/未填 authValue → 回落 env（x-api-key）；
   - `knowledgeBaseIds`（逗号/顿号/分号/空白分隔）：非空限定检索范围，
     留空 = 客户端自动发现全部知识库（60s 缓存）；
   - `type: custom-rest` 暂不接线，按未配置处理回落 env；界面已标注预留。
3. **热加载**：仿 `model-settings-hot` 模式——`createAdaptiveKnowledgeClient`
   初始装配后每 30s 轮询 extension_settings，快照变化才 `updateOptions`
   （`WeKnoraKnowledgeClient` 新增；同时清除 KB 列表缓存）；读失败保持旧
   快照（fail-safe）。未配置时检索抛 `weknora_not_configured`（与缺能力
   同码），且 agent 侧不下发 `retrieve_knowledge` 工具、提示词不含知识库
   语义——「配置了才可见」的既有语义保持，随 30s 快照联动。
4. **消费面**：agent-worker 的 KnowledgeSearch 能力、api 的 knowledge 路由
   客户端、knowledge-provider 代理（改按请求解析）、系统状态
   inspectKnowledge 全部走自适应客户端。设置页保存改为「保存前重读整行
   再合并」（`writePipelineSettingsSection`），收敛丢失更新窗口。
5. **模板修正**：WeKnora 预设认证方式由 Bearer（实测 401）改为
   `X-Api-Key` 头——WeKnora v0.7.1 校验 `x-api-key`。

## 不覆盖（后续项）

- `custom-rest` 通用 REST 连接器语义（请求/响应 JSONPath 映射）未实现；
- knora-bridge（移动端会话桥）仍用 env 引导配置——其服务在注册期一次性
  构建，如界面换端点需同步更新 env 或后续改造；
- 设置页保存仍非服务端事务（无版本号 CAS）；窗口已缩到毫秒级，够用。

## 后果

- 界面改知识库配置无需重启任何进程（≤30s 生效）；「30 秒内生效」提示由
  假变真。
- 首次从零启用知识库（env 与界面均未配置时）仍需重启装配——客户端进程
  启动时若无任何配置则不持有自适应客户端；已有部署不受影响。
- `WEKNORA_KNOWLEDGE_BASE_IDS` env 在界面留空时继续生效，作为兜底范围
  声明。
