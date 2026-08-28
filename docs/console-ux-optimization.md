# Console UX 优化记录（P0–P3）

> 本文档记录 Weflow Console 及其后端链路的交互/易用性优化，供后续会话直接继续。
> 状态：P0–P3 已完成；剩余事项见文末“下次继续”。

## 优化目标

依据 interaction-design-skills 的 lens：

- **Flow**：每个页面只服务一个主任务，路径最短；
- **State**：loading / empty / error / success / transition 明确；
- **Micro-interaction**：开关、拖拽、展开、提交有即时反馈；
- **Affordance**：可点击、可拖拽、可危险操作一眼可辨；
- **Feedback**：每个动作都有结果反馈、可追踪、可审计。

---

## 已完成

### P0：安装向导 + Operation 进度 + 危险操作确认

#### 后端

- `core/modules/solution/interface/http-routes.ts`
  - 新增 `POST /api/v1/admin/solution-packages/analyze`：上传 ZIP 自动解析 Manifest/Lock/Signature，返回人类可读摘要与原始 payload。
  - 抽取 `parseSolutionZip()` 公共解析 helper，`/solutions/import` 同步复用。

#### 前端

- `apps/console/src/weflow/views/SolutionsView.vue`
  - 安装方案改为：上传 ZIP → 自动解析 → 展示摘要 → 确认安装 → 实时进度。
  - 保留“高级 JSON 安装”模式。
  - 导入 ZIP、激活、停用、卸载后自动追踪 Operation 进度（2s 轮询）。
  - 停用/卸载统一使用 `WfConfirmDialog` 危险确认。
  - 页面卸载清理轮询定时器。

---

### P1：运行控制台聚合 + Switch + 乐观更新 + SSE

#### 后端

- `core/modules/operations/interface/http-routes.ts`
  - 新增 `GET /api/v1/admin/runtime-console`：一次返回 settings / allowlists / status / audit。
  - 新增 `GET /api/v1/admin/stream`：SSE 实时推送运行快照，5s 一推 + 25s 心跳。
  - 抽取 `readOperatorStatus()`、`readRuntimeSettingsAudit()`、`buildRuntimeConsole()`。

#### 前端

- `apps/console/src/weflow/components/WfSwitch.vue`（新增）
  - 可复用 Switch，支持 disabled / aria / 滑动动画。
- `weflow-solutions/solutions/customer-support/apps/operations-web/src/views/OperationsConsoleView.vue`（已从 Console 迁至 Solution 层）
  - 首屏改为单次聚合请求。
  - 接入 SSE 实时更新。
  - Agent 总开关、AI 自动回复、知识/记忆/图片理解改为 Switch。
  - 保存采用乐观更新，失败自动回滚。

---

### P2：总览/系统状态/审计聚合 + 分页 + 中文状态

#### 后端

- `core/modules/operations/interface/http-routes.ts`
  - 新增 `GET /api/v1/admin/console/home`：聚合 solutions / dashboard cards / systemStatus。
  - 审计接口支持 `offset` 分页、`actor` 筛选，返回 `hasMore`。
  - 新增 `GET /api/v1/admin/audit/options`：返回事件类型与操作者选项。

#### 前端

- `apps/console/src/weflow/views/OverviewV2.vue`
  - 平台总览改为单次聚合请求。
  - 新增系统状态摘要区块。
  - Dashboard 卡片状态/健康中文化。
  - 30s 自动刷新。
- `apps/console/src/weflow/views/AuditView.vue`
  - 筛选改为显式工具栏（事件类型 / 操作者 / 日期）。
  - 每页 50 条 + “加载更多”。
  - 事件类型下拉使用中文文案。
- `apps/console/src/weflow/views/SystemStatusView.vue`
  - 详情状态中文化。
  - 30s 自动刷新。

---

### P3：命令面板扩展 + 用户分页筛选 + 动效打磨

#### 前端

- `apps/console/src/weflow/components/CommandPalette.vue`
  - 支持搜索页面、已安装方案、用户。
  - 支持 `↑ / ↓`、`Enter`、`Esc`、鼠标悬停选中。
  - 选中项高亮。
- `apps/console/src/weflow/views/UsersView.vue`
  - 新增用户名搜索、角色筛选、状态筛选。
  - 每页 10 人分页。
- `apps/console/src/weflow/views/SystemStatusView.vue`
  - 服务展开时 chevron 旋转 90°。
- `apps/console/src/weflow/views/OverviewV2.vue`
  - Dashboard 卡片增加拖拽把手 `⠿`。

---

## 验证

| 检查 | 结果 |
| --- | --- |
| Core `typecheck` | ✅ |
| Core `eslint modules/operations/interface/http-routes.ts` | ✅ |
| Console `type-check` | ✅ |
| Console `build` | ✅ |

> 全量 `core lint` 仍会被仓库既有 `.data` staging 文件和旧 solution 路由 `any` 问题阻塞，与本次改动无关。

---

## 下次继续（TODO）

### 可继续的功能增强

- [ ] 审计日志导出 CSV
- [ ] 方案安装支持拖拽 ZIP 上传
- [ ] 运行页增加最近 Agent Turn 实时流
- [ ] SSE 断线重连提示 / “已断开，正在重连”状态
- [ ] 命令面板增加“最近访问”和“可执行操作”
- [ ] 用户页后端分页（当前为前端分页，适合小规模账号；大规模需后端 limit/offset）
- [ ] 平台总览“待处理事项”聚合（异常方案、失败 Operation、系统告警合一）

### 技术债 / 注意

- `core/modules/solution/interface/http-routes.ts` 存在较多历史 `any`，后续可逐步用 typed manifest/lock/signature 替换。
- `core lint` 全量失败与 `.data/files/solution-staging` 被 lint 扫描有关，建议后续在 eslint 配置中忽略 `.data/**`。
- SSE 目前为每 5s 轮询 DB 的“伪实时”，后续可改为基于 PostgreSQL LISTEN/NOTIFY 或事件总线推送真正事件。

---

## 涉及文件清单

### 后端

- `core/modules/solution/interface/http-routes.ts`
- `core/modules/operations/interface/http-routes.ts`

### 前端

- `apps/console/src/weflow/views/SolutionsView.vue`
- `weflow-solutions/solutions/customer-support/apps/operations-web/src/views/OperationsConsoleView.vue`（已从 Console 迁至 Solution 层）
- `apps/console/src/weflow/views/OverviewV2.vue`
- `apps/console/src/weflow/views/AuditView.vue`
- `apps/console/src/weflow/views/SystemStatusView.vue`
- `apps/console/src/weflow/views/UsersView.vue`
- `apps/console/src/weflow/components/CommandPalette.vue`
- `apps/console/src/weflow/components/WfSwitch.vue`（新增）
