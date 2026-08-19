# weflow-solution-runner

独立 Solution Runner 进程。

职责：

- 从 Core 领取可执行的 Solution Operation
- 获取 Manifest/Lock/Signature payload
- 用 `@weflow/solution-sdk` 严格校验
- 重算 payload digest 并与 operation 的 `planDigest` 比对
- 按 checkpoint 模拟执行 migrations / deploy / health
- 通过 Core HTTP 回报 checkpoint / complete / fail

环境变量：

- `CORE_API_URL`：Core API 地址
- `RUNNER_TOKEN`：与 Core 配置一致的 Runner 机器身份 token
- `RUNNER_ID`：当前 Runner 实例 ID（默认 `runner`）
- `POLL_INTERVAL_MS`：轮询间隔（默认 5000）

本地联调：

```bash
# 1. 启动 Core API（需配置 RUNNER_TOKEN）
# 2. 用管理员 session token 创建 install operation（SOLUTION_DIR 指向含
#    solution.manifest.json / solution.lock.json / signature.json 的方案目录，
#    如 solutions/knowledge）
CORE_API_URL=http://localhost:3000 ADMIN_TOKEN=<admin-session-token> \
  SOLUTION_DIR=../../solutions/knowledge node scripts/create-operation.mjs

# 3. 启动 Runner
CORE_API_URL=http://localhost:3000 RUNNER_TOKEN=<runner-token> \
  node dist/main.js
```

