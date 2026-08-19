# Weflow Solutions

业务插件与 Solution Pack 仓库。**平台核心仓库（Weflow-Core）不包含任何业务代码**，本仓库是唯一业务来源：在这里开发、构建、发布业务插件，然后在任意 Weflow 平台实例（如 Weflow-Core 的 `release/platform-core`）上安装运行。

## Repository shape

```text
weflow-solutions/
├─ packages/
│  ├─ contracts/        # vendor: @weflow/contracts（平台契约类型，编译期依赖）
│  ├─ plugin-sdk/       # vendor: @weflow/plugin-sdk（插件注册契约）
│  └─ solution-sdk/     # vendor: @weflow/solution-sdk（Solution Pack 校验/打包）
├─ solutions/
│  └─ customer-support/ # 业务 Solution：manifest + lock + signature + backend + plugins
├─ scripts/
│  └─ verify-solution.mjs
├─ package.json         # install:all / build / verify
└─ README.md
```

> `packages/*` 是从平台核心复制的 vendor 副本（SDK 版本与平台 `compatibility.pluginSdk` 声明对齐）。SDK 升级时同步复制并重新构建。

## 插件开发契约（平台加载器约定）

平台 Agent Worker 通过环境变量注入插件，**约定固定导出名**：

| 环境变量 | 加载对象 | 插件导出名 | 契约类型 |
|---|---|---|---|
| `SKILL_PLUGIN_PATH` | Skill | `skill` | `{ id, version, beforeKnowledge?, afterKnowledge?, execute? }` |
| `STRATEGY_PLUGIN_PATH` | Execution Strategy | `strategy` | `AgentExecutionStrategy`（buildModelRequest / parseModelResponse / validateAction） |

插件构建产物（`dist/index.js`）必须包含对应的具名导出，否则平台加载器无法注册。**保持导出名稳定**，这是"一个产物插入任何平台实例"的前提。

## 构建

```bash
pnpm install:all          # 安装 vendor SDK 与全部插件依赖
pnpm build                # 按序构建：contracts → plugin-sdk → solution-sdk → 插件
pnpm verify               # SDK 级校验 solutions/customer-support（manifest/lock/digest）
```

构建顺序有依赖：插件 `tsconfig.json` 的 `paths` 指向 `packages/*/dist/index.d.ts`，因此 vendor SDK 必须先构建。

## 发布（Solution Pack）

`solutions/customer-support/` 是完整 Solution Pack（`solution.manifest.json` + `solution.lock.json` + `signature.json` + `artifacts/*.tgz` + `backend/`）。改动插件源码后需要**重新打包**：

1. `pnpm build` 产出插件 `dist/`
2. 重新生成 `artifacts/*.tgz`（`npm pack` 或 tar）
3. 重新计算 digest 并更新 `solution.lock.json`
4. 更新 `signature.json`（正式发布用平台公钥验签的私钥签名；开发期可用 dev-unsigned 占位）

## 插入平台实例（两种方式）

### 方式一：开发期快捷注入（推荐日常迭代）

在平台 Core 的 Agent Worker 启动时注入本仓库构建产物（无需拷贝）：

```bash
SKILL_PLUGIN_PATH=/path/to/weflow-solutions/solutions/customer-support/plugins/product-troubleshooting/dist/index.js \
STRATEGY_PLUGIN_PATH=/path/to/weflow-solutions/solutions/customer-support/plugins/customer-support-strategy/dist/index.js \
pnpm --dir core dev:agent-worker
```

### 方式二：Solution Pack 安装（发布/测试门禁）

把 `solutions/customer-support/` 的 pack 打成 zip（manifest + lock + signature + artifacts + backend），通过平台 Console 的解决方案页或 `POST /api/v1/admin/solutions/import` 上传安装。安装成功后平台自动：
- 记录 `solution.installations`（observed_state=installed）
- **同步 manifest 声明的 Execution Profile 到 `agent.execution_profiles`**（status=active），Agent Turn 准入与按 `profile.strategyRef` 精确选策略立即可用

随后用带 profile 的门禁验证：

```bash
node scripts/e2e-gate.mjs --profile weflow.customer-support/customer-support-v1
```

（`--profile` 参数让测试 Turn 绑定安装产生的 Execution Profile，验证"按 profile 选策略"而非回退首个策略。）

## 门禁流程（dev → platform）

1. 在本仓库开发/修改插件 → `pnpm build` → 方式一注入平台实例快速验证
2. **自动化门禁**：`pnpm e2e:gate`（见下）对运行中的平台实例跑一轮真实 Agent 轮次
3. 验证通过 → 重新打包 Solution Pack → `pnpm verify` 通过
4. 在平台实例用方式二安装 pack → 端到端测试 → 过关即发布该版本

### e2e:gate 门禁脚本

`pnpm e2e:gate` 连接运行中的平台 Core（需已启动 api + agent-worker，且 worker 注入本仓库插件与 `MODEL_API_KEY`），自动完成：造一条入站消息 + queued Agent Turn → 入队 → 等待 worker 处理 → 打印回复与事件 → 清理测试数据。

```bash
node scripts/e2e-gate.mjs                          # 默认：设备故障消息，期望 reply
node scripts/e2e-gate.mjs --message "我要退款" --expect handoff
node scripts/e2e-gate.mjs --expect any --keep      # 保留测试数据便于排查
```

退出码：`0` 过关（completed 且符合期望）、`2` 完成但结果与 `--expect` 不符、`1` 失败/超时/异常。环境变量 `DATABASE_URL` / `REDIS_URL` 默认指向本地 127.0.0.1。

## Signing

`signature.json` 当前为 dev-unsigned 占位（`keyId: dev-key`），`verify` 脚本对占位签名跳过验签。正式发布前需：
- 生成 Ed25519 签名密钥对，私钥离线保管
- 用平台公钥（部署在平台侧）验签的私钥对 manifest digest 签名，更新 `signature.json`
- 平台侧配置对应公钥后可启用强制验签
