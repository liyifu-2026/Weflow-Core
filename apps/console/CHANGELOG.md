# Weflow Console — Changelog

> 版本化变更记录。详细回归证据见 `RELEASE_CHECKLIST.md`。

## Unreleased

- 统一 Console 包名、`/console/` Vite base path、Core 的 `/api/v1/console/*` 路由与 SSE/Provider 代理路径。
- 删除旧编号兼容路径；Console 只使用 `/api/v1/console/*` 正式入口。
- 「技术文档」页改为渲染仓库根 `docs/technical-documentation.md`，删除过时的 `INTRODUCTION.md` 与硬编码帮助文案。
- **Console UX 优化 P0–P3**：
  - 方案安装改为“上传 ZIP → 自动解析 → 确认 → 实时进度”，新增 `POST /api/v1/admin/solution-packages/analyze`。
  - 危险操作（停用/卸载）统一确认弹窗；Operation 执行进度自动追踪。
  - 运行控制台新增聚合接口 `GET /api/v1/admin/runtime-console` 与 SSE `GET /api/v1/admin/stream`；Agent/自动回复/能力开关改为 Switch 并支持乐观更新。
  - 平台总览新增聚合接口 `GET /api/v1/admin/console/home`，系统状态摘要并入首页。
  - 审计日志支持分页、操作者筛选、事件类型选项接口，筛选改为显式工具栏。
  - 系统状态、Dashboard 卡片状态中文化；系统状态与总览自动刷新。
  - 命令面板支持搜索页面、方案、用户，并支持键盘导航。
  - 用户页支持搜索、角色/状态筛选与分页。
  - 新增 `WfSwitch` 组件；系统状态 chevron 旋转、Dashboard 拖拽把手等动效打磨。
  - 详细记录见 `docs/console-ux-optimization.md`。

## v0.10.0（2026-08-13）— WeKnora 账号联通与内嵌

- **账号联通**：weflow 用户 ↔ WeKnora 账号代管（自动注册 + 租户 10000 成员映射：admin→admin、operator→contributor；凭证 AES-256-GCM 加密存 identity.knora_accounts）
- **平台管理内嵌**：知识页新增「平台管理」模式——一次性 code + bridge 页免密登录，iframe 内嵌 WeKnora 完整界面并深链知识库；工具条含刷新登录/新窗口打开/关闭
- **一次性绑定**：已存在的 WeKnora 账号（leaif@weflow.com 等）首次打开弹密码绑定横幅，支持 bridge 页 postMessage 跨源通知
- 内容模式知识库工具栏新增「完整管理 →」入口；内容模式 KB 行支持直达

## v0.9.0（2026-08-12）— 治理与闭环

- **模型/向量库/存储治理**：Server2 受控端点（schema 校验+错误白名单化）替代透传代理；KnowledgeConfig 管理 UI（模型创建/删除、向量库创建+连接测试、存储创建）；registry 三项升级 available
- **策略回滚 + 版本对比**：Server2 `POST /reply-policies/:id/rollback`（退休版本恢复线上，审计留痕）；PoliciesV2 版本行回滚按钮 + 双版本内容 diff 面板
- **管理员体验修复**：检索配置数据保护（加载失败禁存+diff 确认）、上传反馈链、Coach 候选案例池（反馈→审核→影子基准闭环，`verify-redaction` 端点）、用户搜索/密码复制、错误码白名单化
- **数据源写入标记 Gap**：上游无创建/同步/日志契约（kb_id 传法不明），保持只读如实展示

## v0.8.0（2026-08-12）— Dynamic UX

- **SSE 事件流**：Core `/api/v1/console/events/stream`（事件总线+三发布点）；前端订阅（realtime 60s 对账/断开 5s fallback/focus 立即刷新）
- **Suggestion 建议回复**：Server2 `/conversations/:id/suggestion`（复用知识问答管线）；UI 卡片（采用→Composer 可编辑+光标插入）
- **Race-condition 保护**：select 代际检查 + 增量函数绑定会话
- **样本能力矩阵**：PDF 原生/MD+TXT 文本渲染/DOCX 降级解析文本/PPTX 视解析而定

## v0.7.0（2026-08-12）— Workspace Stabilization

- **客户服务三栏修复**：Inspector 移入 layout（1440 三栏 / 1366+1280 overlay）；container query 按 Workspace 宽度
- **增量刷新**：消除全量重载（Skeleton 闪烁/Inspector 重置/图片重载）
- **Knowledge Power-Up**：Preview 二进制降级（已解析文本）、Wiki 树形（wiki_path）、Contact History（Inspector 内历史会话）

## v0.6.0（2026-08-12）— UX Unification（两轮）

- 统一术语（等待接手/接手处理/我处理中/影子案例…）、WfInspector（三栏+overlay 双形态）、Shell 三组导航、Coach 接活、旧版死代码清理
- drawer→WfInspector 全迁移、策略首屏「当前线上/正在验证/草稿」、纪律审查

## v0.5.0（2026-08-12）— RC Verification 前序修复

- P1.3 状态契约 Bug（mobile 大写状态 normalize）、P2.1 分页 cursor（before= 参数）、registry 响应式（shallowRef revision）
- SSE 事件流、转交状态机两链实测、failed/unknown 真实场景
- 客户服务页重点优化：三区列表支持折叠（分区头点击展开/收起）；顶部计数副行移除；进入会话自动滚动到最新消息；「为什么需要人工」Brief 模块从对话中间移除（统一由右侧 Inspector 展示）；列表行等待时长对齐（tabular-nums 数字等宽、防换行）；用户长名省略号截断；三栏宽度均衡（队列收窄、Inspector 320px、消息区居中限宽 960px）。
