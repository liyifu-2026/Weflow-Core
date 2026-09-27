# 09 · 网页端 support-web（产品唯一网页端）

> 出处：`solutions/customer-support/apps/support-web/`。产品本体 SPA：自带登录 + 应用布局 +
> browser history 真实路径（无 `/support` 前缀、无 hash），由 core-api 静态托管。

## 1. 技术栈

| 项 | 值 |
|----|-----|
| 包 | `@weflow-leaif/support-web` **2.0.0**（private） |
| 框架 | Vue 3.5 + vue-router（`createWebHistory`）+ Pinia 4 |
| 构建 | Vite 7 + vue-tsc（`build = vue-tsc --noEmit && vite build`）；sourcemap 开 |
| 样式 | Tailwind v4（`@tailwindcss/vite`）+ shadcn-vue（new-york/zinc）+ reka-ui + tw-animate-css |
| 字体 | Geist 变量字体本地化（woff2 入库），中文回退 PingFang SC/微软雅黑，无 CDN |
| 图标 | lucide-vue-next |
| 测试 | vitest + happy-dom（`tests/`：handoff-vocab、transcript-merge、use-contact-list、use-conversation-realtime） |
| dev server | 5174（`--strictPort`）；代理 `/api` 与 `/customer-support` → `CORE_API_TARGET`（默认 3100） |
| allowedHosts | `web.leaif.com` / `.leaif.com` / localhost（frpc 隧道直入） |

样式纪律（`src/styles/tailwind.css`，文件头自述「第 1 批定稿后冻结」）：纯 Zinc 语义色板，
业务代码只许 `bg-background/text-foreground` 等语义类、禁止硬编码色值；暗色 `.dark` 类策略。

## 2. 路由全表（`src/router.ts`）

| 路径 | 视图 | 说明 |
|------|------|------|
| `/login` | LoginView | `meta.public`；已登录访问 → `/conversations` |
| `/change-password` | ChangePasswordView | 首登强制改密双向重定向 |
| `/conversations` | ConversationsV2 | 会话工作台（默认落点） |
| `/scheduled-sends` | ScheduledSendsView | 定时任务全局管控面 |
| `/knowledge`（`/knowledge/validate` 重定向带 `mode=validate`） | KnowledgeV2 | 知识工作区 |
| `/assets` | AssetsView | 素材空间 |
| `/admin` | AdminView（admin） | 现只承载联系人策略（白名单页入口） |
| `/ai-employees`（+ `/:definitionId/prompt` 深链） | AiEmployeesView（admin） | AI 员工版本管理 |
| `/system/users` / `/system/audit` / `/system/status` | Users / Audit / SystemStatus（admin） | 平台管理页 |
| `/settings` | SettingsView（admin） | 设置中心六分区 |
| `/profile` | ProfileView | 个人资料（全员） |
| `/:pathMatch(.*)*` | redirect → `/conversations` | SPA 兜底 |

全局守卫 `beforeEach`：`ensureSession()`（并发去重）→ public 页已登录重定向 →
未登录带 `?redirect=` 回跳 → `mustChangePassword` 强制改密 → `meta.admin` 非 admin 回工作台。

## 3. 认证与 API 客户端

- **无 token**：Cookie 会话浏览器自动携带（fetch 一律 `credentials:"include"`）；会话失效 =
  API 错误码 `authentication_required` → 回登录页。无刷新机制。
- `src/api.ts`：同源 fetch 封装；JSON 30s / 上传 600s 超时；204 → undefined；
  非 2xx 抛 `ApiError{status, code}`，`errorCopy()` 映射 44 个服务端错误码为中文文案
  （全集见 05 章 §15）。
- Pinia stores：`weflow-auth`（会话/头像/资料）、`weflow-conversation-workspace`
  （按用户开工作区：搜索/回复草稿/滚动位置，切会话不丢）、`weflow-knowledge-workspace`、
  `weflow-navigation-context`（会话↔知识往返）；登出统一 `resetSupportWorkspaceStores()`。

## 4. 应用骨架（`src/layout/AppShell.vue`）

可折叠侧栏（`w-56 ↔ w-16`，localStorage `wf-sidebar`）：
- 工作台组：会话 / 知识库 / 素材 / 定时任务。
- 管理组（仅 admin）：AI员工 / 管理 / 设置 / 系统状态 / 用户与角色 / 审计日志。
- 底栏：StaffAvatar + 显示名/角色 → `/profile`、明暗主题切换（`wf-theme`）、退出登录。

## 5. 会话工作台（ConversationsV2，753 行组合层）

架构：状态与机制全部下沉 composables（`src/composables/use-conversation-*.ts`），视图只做组装；
依赖单向 list→selection→inspector/actions→realtime。

**左栏 ConversationList**：单一搜索框（空态=三区队列；输入 300ms 防抖同搜会话+联系人）；
三区队列 `attention`（等待处理，红）/`mine`（我处理的，蓝）/`others`（其他对话，灰）——
服务端 scope 排序：attention 按风险（high300/medium150）+handoff（pending200/in_progress100）+未读；
黑名单制（0078）：列表不再按 agentEnabled 过滤，已拉黑由 Core 排除；游标续页。

**中栏 ChatPane**：
- 线程头：联系人头像/名称按钮、会话状态徽章（`AI 接待中 · 第 N 轮` / `等待客户 · 第 N 轮` /
  `已收尾` / Handoff 徽章 / 唤醒倒计时）、更多操作下拉、简报行（降噪：事实 ≤3 条、未决 ≤2 条）。
- 消息滚动区：滚到顶自动加载更早（锚恢复相对位置；距底 ≤72px 视为在底部）。
- **TurnRail 回合侧轨**：ChatGPT 式 minimap——AI 轮（replied/failed/in_flight/未回复四态）、
  人工轮（handoff cycle 区间 + 处理人）、唤醒点（空心点）；dock 式放大 + 回合摘要卡片跳转。
- 「AI 正在思考」胶囊：2s live-turn 轮询，阶段文案（判断消息类型/装配上下文/规划工具/检索完成/
  工具完成/整理回复/生成回复/深入思考），连续失败 ≥3 次清除。
- wait 时间线节点（倒计时胶囊）；新消息提示条；接管条 HandoffBar（「能看≠能回复」）或 Composer。

**MessageBubble**：微信客户端式——拍一拍/系统事件居中小字；文本三态（人工=primary 实底反白 /
Agent=secondary 浅底 / 客户=muted 灰底）；图片 ≤300px；表情贴纸 ≤160px；文件卡片；语音；视频；
引用回复卡片（左竖线+作者+40 字摘要）；@提及高亮；meta 行降噪（客户只显时间）；
failed→重试、unknown→重新发送（查证语义见下）、held→「已拦截」（终态不自动补发，需送达则
人工另发新消息）；入站头像右键=拍一拍；深链定位高亮。

**Composer**：表情 32 枚浮层 / 图片 / 文件 / 素材空间；引用回复预览条；`Ctrl/⌘+Enter` 发送；
@提及浮层（`@` 触发、姓名过滤）。

**发送语义**：`clientRequestId`（crypto.randomUUID）幂等；失败重试复用同 ID；
unknown 自动查一次，仍未知显示「查询结果」并禁止重发（提示换新 ID 补发——防双发）。

**右侧 InspectorPanel（上下文检查器）五视图**：①当前上下文（轮次体检计数、回合状态、定时消息、
简报）；②交接说明；③回答依据（evidence）；④客户资料（note/tags/agentEnabled 编辑）；⑤历史对话
（只读）。偏好 `wf-inspector`；**桌面端默认收起**（`shell.ts` 首次写 `collapsed`，手动展开后不再覆盖）。

**SessionTraceDrawer 决策轨迹**：turn 概览（status/model/errorCode/traceId/耗时/分段折叠）+
事件时间线（**27 类中文标签** + 工具执行参数/结果 + 相对耗时）+ 思维链/模型原文折叠 + 失败/抑制横幅。
27 类标签全集（`ConversationsV2.vue` `TRACE_EVENT_LABELS`）：领取轮次、分流、决策、回复落库、
上下文装配、工具规划、工具检查点、工具完成、工具租约回收、恢复续跑、知识检索、模型调用、思维链、
校验通过、校验失败、策略抑制、转人工、执行出错、轮次失败、定时发送已排、定时发送取消、投递确认、
投递失败、投递未知、续步回复落库、过程短讯落库、回复被扣留。

**其他交互**：`⌘/Ctrl+Shift+H` 快捷接管；Esc 关浮层；转交弹窗（原因必填 + 客服/专业队列分段）；
会话设置弹窗（仅「允许 Agent 自动回复」开关）；消息右键菜单（回复/拍一拍）；
深链 `?id=&messageId=`；自动选中（我处理的第一条 → 等待处理 → 其他）。

**实时机制**（`use-conversation-realtime.ts`）：SSE 失效信号（11 类白名单，250ms 尾沿合并）+
15s 对账 / 5s 兜底轮询 + 回前台/SSE 重连立即对账；转录增量合并（append + 就地 patch，
不重挂图片不清草稿）。

## 6. 设置中心（`/settings`，admin，六分区）

单页分区导航（180px），`?section=` 同步；**dirty 保护**（切分区/离开 confirmDialog）。

| 分区 | 配置内容 | 存储位置 | 生效 |
|------|----------|----------|------|
| AI 员工 | 员工入口 + 行为参数（会话 TTL 45min/轮数 24/**wait 缺省时长 defaultWaitMs 300s**（wait 动作未带 wait_ms 时的回退值，非上限；与插件 reply 交权缺省 90s 的辨析见 06 章 §12）/nudge/提醒话术与延迟/步预算 4） | extension_settings `behavior` | ≤30s |
| 模型 | 注册表（名称/端点/密钥有无/能力 文本·视觉·语音/超时/故障转移/启停）+ 五槽位（text/vision/asr/triage/fast）+ 健康状态 | model_registry | ≤15s |
| 知识库 | 连接器：类型（weknora 预设/custom-rest 预留）、检索端点、认证（none/Bearer/Header，WeKnora=X-Api-Key「Bearer 会 401」）、KB ID 范围、请求/响应字段映射 JSON、adminUrl | extension_settings `knowledgeConnector` | ≤30s，缺省回落 `.env WEKNORA_*` |
| 行为 | 7 全局开关（Kill Switch/自动发送/合并窗口/插话闸门/知识检索/长期记忆/图像理解；DB 键名与出厂值见 06 章 §13——出厂全开、合并窗口默认关） | runtime_settings | 即时（消费方热读） |
| 安全 | 联系人策略入口 + 群聊策略（触发模式四选一：`mention_only`=仅 @ 命中（种子默认）／`mention_or_keyword`=@ 或关键词／`accept_all`=按概率全收／`off`=关闭；响应关键词；冷却期 + 冷却内最大回复数默认 2；概率 probability；额外指令；按群 override——四模式语义详见 06 章 §7） | extension_settings `groupChat` | ≤30s |
| 部署 | 只读：服务探活 + 环境键展示（改 .env 重启生效） | — | — |

扩展设置写入前**重读整行合并**（防丢失更新，`settings/common.ts`）。

## 7. 其余页面要点

- **ScheduledSendsView**：时间-任务表，状态筛选；立即发（frozen 禁用）/改期（静音时段
  22:00–08:00 顺延至 08:00）/撤销；`new_inbound` 取消原因显示「因用户新消息作废」。
- **KnowledgeV2**：validate（证据验证流）/content（只读浏览）双模式；数据走 Core 路由不直连
  WeKnora；外部管理经 `/knora/redirect` 同源跳转；证据归一化（分数百分比）+ 高亮 + 搜索统计。
- **AssetsView**：网格（≥150px 卡片）、分类 Tabs、搜索、上传、改名（≤255 字符）/软删
  （「已发送的消息不受影响」）、IntersectionObserver 无限滚动（keyset limit=30）。
- **WhitelistView**（联系人策略）：三态互斥 Tab（AI 自动回复/仅人工/已拉黑）；乐观更新失败回滚。
- **AiEmployeesView**：定义列表（草稿/已发布/已归档徽章）+ 版本管理（新建/编辑/发布/回滚为线上）
  + 服务名单（显式绑定联系人 + 共享默认，绑定优先；Contact Profile 的 Agent 开关关闭仍优先禁止）。
- **UsersView**：发放账号/改角色/重置密码/撤销 Session/禁用启用 + 筛选分页。
- **AuditView**：事件类型/操作者/日期筛选 + 50/页 + 详情弹窗 + URL query 同步。
- **SystemStatusView**：服务健康矩阵（configuration × health）+ 最近 Turn 诊断表 + 自动刷新。
- **ProfileView**：头像（DiceBear 预设网格/本地上传 JPG·PNG·WebP/恢复默认）+ 显示名（1–24 字符，
  空回落用户名）。
- **LoginView / ChangePasswordView**：见路由表；品牌字「WeFlow」+「使用由管理员发放的 Weflow 账号」。

## 8. 组件与工具层（`src/components/`、`src/composables/`）

- 媒体渲染族：`MediaImage`（缩略 ≤300px + 惰性全屏原图第二路，失败降级缩略）、`MediaFile`
  （流式下载 + 圆形进度 + 保留原名；PDF/图片/text 可「打开预览」Blob URL）、`VoiceMessage`
  （play/pause + 时长校准 + 转写文本；`audio/silk` 显示不可播占位但转写仍显示）、`VideoMessage`
  （内联 video）。
- `use-authenticated-blob`：cookie fetch → Blob → object URL → 卸载 revoke；模块级缓存 100 条 FIFO。
- `AssetPicker`：三来源（本机/图片空间/文件空间）+ 空间管理（分页/搜索/改名/删除，管理员可见管理钮）。
- `handoff-vocab.ts`：Handoff 展示词汇表纯函数（状态归一化/标签/Composer 占位/capability 关闭时
  本地推导回退；**字段缺失即只读 fail-safe**）。
- `labels.ts`：共享中文标签映射（防御式未知值回落）。
- `StaffAvatar` 三级：avatarUrl / 用户头像端点 / DiceBear 预设（按显示名稳定哈希，与 Core 同算法）/
  首字母占位。
- `WfConfirmDialog` + `confirm-dialog.ts`：promise 化全局确认弹窗。
- 桌面壳适配：`shell.ts` `isDesktopShell()`（`?shell=desktop` 或 `__TAURI__`）+
  `applyDesktopShellDefaults()`（检查器默认收起）。
- 响应式：工作台三栏 grid，`max-[860px]` 降两栏（Inspector 让位）。
