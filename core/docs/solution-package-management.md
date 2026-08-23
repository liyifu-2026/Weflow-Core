# Solution 包管理（npm 风格）

> 状态：已实现（自 wxbot 迁入，2026-08）
> 模型：Solution Store + Registry 是安装事实的唯一来源；Core 数据库不参与
> 安装状态管理。

## 1. 为什么 npm 风格

第一代模型的问题：

- Core 通过操作队列执行安装，数据库成为事实源，CLI 与平台耦合；
- 没有受管安装目录与 lockfile；
- 升级/回滚依赖 DB 状态机。

npm 已验证了这套模型：版本、lockfile、registry、semver、可回滚。Weflow
Solution 采用同一心智模型。

## 2. 核心概念

| npm 概念                 | Weflow Solution 对应                                          |
| ------------------------ | ------------------------------------------------------------- |
| `package.json`           | `solution.manifest.json` + `solution.lock.json` + `signature.json` |
| npm registry             | Solution Registry（本地目录或 HTTP）                          |
| `npm install <pkg>`      | `weflowctl solution install <package>`                        |
| `node_modules/<pkg>`     | `<store>/<id>/<version>/`                                     |
| `package-lock.json`      | `weflow-solution.lock.json`                                   |
| `npm update`             | `weflowctl solution update`                                   |
| `node_modules/.bin` 软链 | `<store>/<id>/active` junction                                |
| `npm publish`            | `weflowctl solution publish <dir>`                            |
| semver                   | 更新策略 manual/patch/minor/major                             |

## 3. 目录布局

```text
~/.weflow/                        # WEFLOW_HOME 可覆盖
  solutions/                      # WEFLOW_SOLUTION_STORE 可覆盖
    <solution-id>/
      <version>/                  # 不可变安装快照
        solution.manifest.json
        solution.lock.json
        signature.json
        plugins/<id>/dist/plugin.js
      active -> <version>         # 当前激活版本 junction
    weflow-solution.lock.json     # 安装清单 + 激活历史
  registry/                       # 本地 registry（WEFLOW_SOLUTION_REGISTRY_ROOT 可覆盖）
    <solution-id>/
      <version>.tgz
      index.json
  keys/
    dev-signing-key.pem(.pub)     # 开发签名密钥对（机器级信任锚）
```

## 4. 安装 / 激活 / 升级 / 回滚

- **publish**：stage（esbuild 打包插件）→ 写 lock → ed25519 签名 → tgz。
- **install**：校验三件套与签名 → 解包进 store；不激活。
- **activate**：原子切换 `active` junction；写入激活历史。
- **update**：按 semver 策略选目标 → 预检健康门 → 原子切换 → 失败自动回滚。
- **rollback**：按激活历史回退最近的不同版本（可 `--to` 显式指定）。

执行入口只有 `weflowctl`。Core 不提供安装写路径。

## 5. 平台侧投影

Core 只读 Store：

- `core/modules/solution/interface/store-routes.ts`：
  - `GET /api/v1/admin/solutions` — 安装版本与 active 版本列表；
  - `GET /api/v1/admin/solutions/extensions` — active manifest 声明的
    `consoleExtensions`（供 Console ExtensionHost）；
  - `GET /api/v1/admin/solutions/:id` — 单个 Solution 详情与健康摘要。
- `core/infrastructure/solutions/solution-plugin-loader.ts`：启动时枚举
  store 的 active junction，经 SDK 校验 manifest 后动态 import
  `dist/plugin.js`，由 `solution-plugin-adapter.ts` 适配进 RuntimeKernel。
- `core/apps/solution-runner/main.ts`：Store 观察进程（健康检查 + 插件加载 +
  状态端点），使用 `WEFLOW_SOLUTION_STORE`，无数据库依赖。

## 6. HTTP Registry

独立进程 `core/apps/solution-registry/main.ts`：

```text
GET  /v1/solutions                  -> registry 列表
GET  /v1/solutions/:id              -> 版本索引（index.json）
GET  /v1/solutions/:id/:version     -> 单版本元数据
GET  /v1/solutions/:id/:version.tgz -> tarball 下载
PUT  /v1/solutions/:id/:version     -> 发布（Bearer token + 服务端验签，fail-closed）
```

环境变量：

- `SOLUTION_REGISTRY_PORT`（默认 3200）
- `WEFLOW_SOLUTION_REGISTRY_ROOT`（默认 `~/.weflow/registry`）
- `WEFLOW_SOLUTION_REGISTRY_TOKEN`：设置后才能发布；未设置时发布端点整体关闭。
- `WEFLOW_SOLUTION_REGISTRY_READ_TOKEN`：设置后所有读端点要求该 Bearer token
  （默认回落到发布 token）。

发布前服务端会重新解包并验签；签名公钥来自
`WEFLOW_SOLUTION_TRUSTED_SIGNING_PUBLIC_KEY` 或开发信任锚。

## 7. 关键语义

- **信任锚机器级**：开发签名密钥固定在 `~/.weflow/keys/dev-signing-key.pem`
  （首次 publish 自动生成），publish、registry 验签、全新 store 安装解析同一
  密钥材料。生产必须显式提供可信公钥，否则 fail-closed。
- **包自包含**：tgz 内插件为 bundle 后代码，store 安装不依赖源 workspace 的
  `node_modules`。
- **激活历史**：store lockfile 记录 activations 日志，`rollback` 优先按最近
  激活版本回退。
- **密钥安全**：私钥与 token 不进入日志；`signature.json` 只含 keyId 与签名值。

## 8. CLI

见 `tooling/weflowctl/src/weflowctl-solution.ts`（命令层）与
`src/cli-errors.ts`（稳定错误码表）。常用命令：

```bash
# 先构建一次：pnpm --dir tooling/weflowctl build
weflowctl="node tooling/weflowctl/dist/tooling/weflowctl/src/cli.js"

$weflowctl solution publish <source-dir> [--out <dir>] [--registry <url>]
$weflowctl solution install <dir|tgz|<id>> [--registry <url>] [--version v]
$weflowctl solution activate <id> [version]
$weflowctl solution update <id> --strategy patch|minor|major|manual [--registry <url>]
$weflowctl solution rollback <id>
$weflowctl solution list [id]
$weflowctl solution doctor
```

全局支持 `--json` / `--quiet` / `--help`；`registry login|logout|status` 与
`keygen / key list|import|export` 管理凭证与签名密钥。

## 9. 待决策

- [ ] 升级是否允许自动执行 Solution 提供的数据库 migration
- [ ] 回滚是否支持 downgrade migration（当前禁止）
