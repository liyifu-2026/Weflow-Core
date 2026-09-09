# Weflow Solutions

Weflow AI 客服产品的业务仓库。**平台核心仓库（Weflow）不包含任何业务代码**，本仓库是唯一业务来源：产品网页端（support-web）、移动端（mobile）、业务插件与业务 BFF 都在这里。

R3 平台化拆除后插件**不再打包安装**：平台 Core 通过 `WEFLOW_PLUGIN_DIR` 环境变量直读本仓库的插件目录。

## Repository shape

```text
weflow-solutions/
├─ packages/
│  ├─ contracts/        # vendor: @weflow/contracts（平台契约类型，编译期依赖）
│  └─ plugin-sdk/       # vendor: @weflow/plugin-sdk（插件注册契约）
├─ solutions/
│  └─ customer-support/ # 业务 Solution：backend + plugins + apps
├─ scripts/
│  └─ e2e-gate.mjs
├─ package.json
└─ README.md
```

> `packages/*` 是从平台核心复制的 vendor 副本（SDK 版本与平台声明对齐）。SDK 升级时同步复制并重新构建。

## 插件开发契约（平台加载器约定）

Core Agent Worker 从插件目录直读，**约定固定导出名**：

| 加载方式 | 加载对象 | 插件导出名 | 契约类型 |
|---|---|---|---|
| `WEFLOW_PLUGIN_DIR/plugins/<name>/dist`（目录直读） | 全部插件 | `skill` / `strategy` / `createStrategy` | 见下 |
| `SKILL_PLUGIN_PATH`（显式覆盖） | Skill | `skill` | `{ id, version, beforeKnowledge?, afterKnowledge?, execute? }` |
| `STRATEGY_PLUGIN_PATH`（显式覆盖） | Execution Strategy | `strategy` | `AgentExecutionStrategy`（buildModelRequest / parseModelResponse / validateAction） |

插件构建产物（`dist/index.js`）必须包含对应的具名导出，否则平台加载器无法注册。**保持导出名稳定**。

Core API 进程从 `WEFLOW_PLUGIN_DIR/backend/<key>/index.js` 直读 BFF，导出 `registerRoutes(server, ctx)`。

## 构建

```bash
pnpm install:all          # 安装 vendor SDK 与全部插件依赖
pnpm build                # 按序构建：contracts → plugin-sdk → 插件 → support-web
```

构建顺序有依赖：插件 `tsconfig.json` 的 `paths` 指向 `packages/*/dist/index.d.ts`，因此 vendor SDK 必须先构建。

## 平台接入与 e2e 门禁

开发期把 core/.env 的 `WEFLOW_PLUGIN_DIR` 指向本仓库 solution 目录（默认已配置），平台 dev up 即自动加载全部插件与 BFF；`SKILL_PLUGIN_PATH` / `STRATEGY_PLUGIN_PATH` 仍可显式覆盖单个插件。

`pnpm e2e:gate` 连接运行中的平台 Core（需已启动 api + agent-worker 与 `MODEL_API_KEY`），自动完成：造一条入站消息 + queued Agent Turn → 入队 → 等待 worker 处理 → 打印回复与事件 → 清理测试数据。

```bash
node scripts/e2e-gate.mjs                          # 默认：设备故障消息，期望 reply
node scripts/e2e-gate.mjs --message "我要退款" --expect handoff
node scripts/e2e-gate.mjs --expect any --keep      # 保留测试数据便于排查
```

退出码：`0` 过关（completed 且符合期望）、`2` 完成但结果与 `--expect` 不符、`1` 失败/超时/异常。环境变量 `DATABASE_URL` / `REDIS_URL` 默认指向本地 127.0.0.1。
