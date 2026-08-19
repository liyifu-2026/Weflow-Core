# Weflow

Weflow 是面向企业服务场景的 **AI 员工平台**。它把多入口消息、Agent Runtime、业务事实和人工协作组织成一个可替换、可审计的系统。本仓库是 Weflow Platform Core：平台底座（Core、Console、Solution Runner、SDK、weflowctl）与官方基础 Solution（知识库、记忆）。

技术文档入口：[docs/technical-documentation.md](docs/technical-documentation.md)；Console 帮助页直接渲染该文档。

## Repository shape

```text
weflow/
├─ core/                         # Weflow Core：业务事实、Agent、Runtime、持久化与对外 API
│  ├─ apps/
│  │  ├─ api/                   # HTTP API 组合根
│  │  ├─ agent-worker/           # Agent Turn、Memory 队列消费者
│  │  └─ ingestion-worker/       # 图片/语音等媒体处理队列消费者
│  ├─ modules/                   # Domain/Application 模块
│  ├─ infrastructure/            # 数据库、队列、Provider Adapter、Runtime Kernel
│  ├─ migrations/
│  └─ tests/
├─ packages/
│  ├─ contracts/                 # 稳定公共契约
│  ├─ plugin-sdk/                # Plugin 注册契约
│  ├─ solution-sdk/              # Solution Pack 契约/Planner/签名
│  ├─ admin-sdk/                 # Core Admin 客户端
│  ├─ ui/                        # 共享 UI 工具
│  └─ consumer-fixture/          # 消费者契约测试 fixture
├─ apps/
│  ├─ console/                   # 平台管理 Console
│  └─ solution-runner/           # 独立 Solution Runner
├─ solutions/
│  ├─ knowledge/                 # 官方基础 Solution：知识库
│  └─ memory/                    # 官方基础 Solution：记忆
├─ tooling/
│  └─ weflowctl/                 # CLI
├─ scripts/                      # 统一验证脚本
├─ contracts/
│  └─ channel/                   # 跨进程 Channel 协议说明
├─ deploy/
└─ docs/
```

## Runtime vocabulary

- **Core** 持有 Conversation、Message、Case、Handoff、Memory、Audit 等业务事实，并运行 Agent Runtime（ExecutionStrategy/Skill 由 Solution 插件提供）。
- **Channel Host** 是平台级通道入口适配层：负责连接外部入口、可靠事件存储、发送操作与媒体引用解析。Core 通过 `channel.events`、`channel.send`、`channel.media`、`channel.contacts` 四个正式能力契约与 Channel Host 通信，不感知具体通道实现。协议说明见 [contracts/channel/README.md](contracts/channel/README.md)。
- **Console** 面向管理、知识运营和系统观察；**Solution Runner** 独立执行 Solution Pack 生命周期操作。
- **Provider** 是可替换的外部能力实现。ZhiNanKB/WeKnora 保持在系统外部，通过 Knowledge Provider 接入；TextModel、Vision 等同理。

正式 Channel 能力契约是：`channel.events`、`channel.send`、`channel.media`、`channel.contacts`。入口适配器负责把通道细节转换为契约，Core 只消费统一的 Conversation Event、Media Ref 和 Contact Profile。

## Current convergence rule

本仓库是 Weflow 的平台核心干净快照。旧的客服业务应用目录（apps/support-web、apps/support-bff、apps/mobile）与微信实现目录（channel-host-wechat、wechatauto）已从仓库移除；客服业务插件已迁出为独立仓库 **Weflow-Solutions**（`github.com/liyifu-2026/Weflow-Solutions`），遵循平台插件契约（插件导出 `strategy`/`skill`，经 `SKILL_PLUGIN_PATH`/`STRATEGY_PLUGIN_PATH` 注入或 Solution Pack 安装后按 Execution Profile 选择）。本仓库只保留官方基础 Solution：`solutions/knowledge`、`solutions/memory`。`wechatbot-new` 保持为独立归档仓库，它的 Agent、Prompt、Memory 和回复策略不再复制到 Weflow。来源与迁移记录见 [docs/migration/source-manifest.md](docs/migration/source-manifest.md)。

短期兼容代码可能仍出现 `Server1` 字样，但新代码和新文档统一使用 `Channel Host`、`Core`、`Console`。

## Development

每个应用保留自己的包管理器。根目录只负责说明拓扑，不强行把 Python、pnpm、npm 等工具链揉成一个包。

- Core：进入 `core/`，使用 `pnpm check`
- Console：进入 `apps/console/`

### Phase 7 unified verification

根目录 `package.json` 提供统一验证入口：

```bash
pnpm install:all          # 安装 Core / Console / Solution Runner / SDK / weflowctl 依赖
pnpm platform:verify      # Core check + Console check + SDK build/test + weflowctl + Solution Runner
pnpm platform:verify:ci   # 同 platform:verify，但强制要求 TEST_DATABASE_URL
pnpm solution:verify      # SDK 级校验官方 Solution（knowledge / memory）的 manifest/lock/一致性/digest
pnpm release:verify       # 发布门禁：SDK + 应用 + Secret 扫描 + release report
```

- `platform:verify` 会原样透传环境变量；当设置 `TEST_DATABASE_URL` 时，Core 的集成测试会自动纳入 `pnpm check`；未设置时会打印警告并只跑单元测试。
- `platform:verify:ci` 用于 CI，未设置 `TEST_DATABASE_URL` 直接失败。
- Solution Runner 需要 `SOLUTION_PUBLIC_KEY_FILE`（或 `SOLUTION_PUBLIC_KEY`）与 `SOLUTION_STAGING_ROOT`；生产模式必须配置公钥，开发模式可用 `SOLUTION_DEV_UNSIGNED=1` 跳过验签。
- 根目录 `package.json` 只做编排，不改变各子项目各自的包管理器。

### weflowctl Solution 管理

```bash
# 本地校验（manifest/lock + file artifact digest；官方基础 Solution 为 dev-unsigned 占位签名，不随附公钥）
pnpm --dir tooling/weflowctl build
node tooling/weflowctl/dist/cli.js solution validate \
  --manifest solutions/knowledge/solution.manifest.json \
  --lock solutions/knowledge/solution.lock.json

# 生命周期（需要 Core Admin token）
node tooling/weflowctl/dist/cli.js solution status <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution activate <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution disable <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution uninstall <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution rollback <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution health <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution logs <operation-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>

# 升级（需要新的 manifest/lock/signature）
node tooling/weflowctl/dist/cli.js solution upgrade \
  --manifest solutions/knowledge/solution.manifest.json \
  --lock solutions/knowledge/solution.lock.json \
  --signature solutions/knowledge/signature.json \
  --core-url http://127.0.0.1:3100 --admin-token <token>

# 本地对比当前安装版本与本地 manifest/lock
node tooling/weflowctl/dist/cli.js solution diff <solution-id> \
  --manifest solutions/knowledge/solution.manifest.json \
  --lock solutions/knowledge/solution.lock.json \
  --core-url http://127.0.0.1:3100 --admin-token <token>

# Secret 配置引用（只存引用，不存明文 Secret）
node tooling/weflowctl/dist/cli.js solution secrets <solution-id> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution secret set <solution-id> <slot-name> \
  --type env --ref API_KEY \
  --core-url http://127.0.0.1:3100 --admin-token <token>
node tooling/weflowctl/dist/cli.js solution secret unset <solution-id> <slot-name> \
  --core-url http://127.0.0.1:3100 --admin-token <token>
```

> 以上以 `solutions/knowledge` 为例；`weflowctl solution verify` 需要公钥，官方基础 Solution 当前为 dev-unsigned 占位签名，请使用 `solution validate` 做 SDK 级校验（见 `scripts/solution-verify.mjs`）。

### 架构收敛说明

见 [docs/architecture/repository-convergence.md](docs/architecture/repository-convergence.md)。
