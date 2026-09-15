# weflowctl

Weflow 命令行工具。R3 平台化拆除后仅保留平台运维域（原 `solution` 命令族随 Solution Pack 机制一并删除）：

## dev — 开发环境健康与生命周期

```bash
weflowctl dev doctor   # 体检各服务（端口、健康探针、进程陈旧检测）
weflowctl dev up       # 拉起本地开发环境（Core 三进程 + support-web Vite 等，服务定义见 src/dev/definitions.ts）
weflowctl dev down     # 停止开发环境
```

## service — Windows 服务管理（api / agent-worker / ingestion-worker）

```bash
weflowctl service install | uninstall | start | stop | restart | status
```

## config — 本地 CLI 配置（~/.weflow/config.json）

```bash
weflowctl config get <key>     # 读单项（敏感值打码）
weflowctl config set <key> <value>
weflowctl config list
```

当前保留 `registry.url` / `registry.token` 键骨架供后续平台配置使用。

## completion — shell 补全脚本

```bash
weflowctl completion bash | zsh | powershell
```

## 全局 flags

`--json`（结构化输出）、`--quiet`（仅错误）、`--help`、`--version`。
