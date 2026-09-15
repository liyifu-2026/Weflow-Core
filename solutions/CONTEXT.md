# Weflow 业务子树上下文（solutions/CONTEXT.md）

业务子树（`solutions/`）的领域词汇表与模块地图。工作区全局架构见根 `CONTEXT.md`，
引擎层词汇表见 `weflow/core/CONTEXT.md`，执行守则见 `solutions/AGENTS.md`。本文由 2026-09-09
架构评审（improve-codebase-architecture）收敛而来：候选 6（工作台深化 C 档）、
7（BFF 遗留路由）、12（策略插件决策协议）。

## 总体模块地图

```
solutions/customer-support/
├── apps/support-web/            # 产品网页端（唯一业务 UI）
│   ├── src/composables/         # 工作台机制模块（见下表）
│   ├── src/lib/handoff-vocab.ts # Handoff 展示词汇表
│   ├── src/views/               # 视图 = 组装接线 + 模板编排
│   └── tests/                   # vitest（happy-dom）
├── plugins/customer-support-strategy/   # Execution Strategy 插件
│   ├── src/decision-protocol.ts # 决策协议单一事实源
│   ├── src/{prompt,parser,index}.ts
│   ├── tests/                   # node:test（含字节级 golden 快照）
│   └── scripts/render-golden-prompts.ts # golden 再生成（有意改协议时用）
└── backend/customer-support/    # 业务 BFF（AI 员工管理 + 会话只读投影）
```

## 领域词汇表（新增）

| 术语 | 含义 |
|------|------|
| 会话新鲜度控制器（Conversation Freshness Controller） | 工作台实时性的唯一机制模块（`composables/use-conversation-realtime.ts`）：消费 Core 的 SSE 失效信号（ADR-0009：事件只是失效信号，收到即回拉权威状态）、250ms 尾沿合并事件风暴、「15s 对账 / 5s 兜底轮询」降级、回前台立即对账、2s live-turn「AI 正在思考」轮询。降级语义的历史踩坑（fallback 定时器必须置空、连续失败 ≥3 次清气泡、重连立即对账）以注释形式钉在该模块里。mobile 端存在平行实现（仓外），未来接入时它是第二个 adapter，接缝届时才算数 |
| Handoff 展示词汇表（Handoff Presentation Vocabulary） | `lib/handoff-vocab.ts`：Core Handoff 事实的多种方言（contract 小写、Mobile 大写、cycle 历史词汇）到 UI 单一词汇的唯一投影点——状态归一化、文案、按钮可见性（capability 关闭时的本地推导回退）、Composer 派生文案。全仓只此一份；改 Handoff 文案/按钮规则只来这里 |
| 决策协议（Decision Protocol） | `plugins/customer-support-strategy/src/decision-protocol.ts`：模型决策契约的单一事实源——`NEXT_ACTION_VALUES`（8 值，与 parser 的 switch 一一对应）、`WAIT_MS`（min/max/fallback + 提示词散文）、沙箱工具名清单，以及内置路径与 AI 员工路径共享的提示词协议块。新增动作 = 改这一个文件 + parser 加 case，两条提示词路径散文自动同步。它是 Core 决策契约（9 值）的业务子集：不含 `schedule_send`（联系人级开关、业务提示词不提供），parser 收到时按 reply 降级（字节级测试钉住） |
| 认证媒体拉取（Authenticated Blob Lifecycle） | `composables/use-authenticated-blob.ts`：cookie 凭证 fetch → Blob → object URL → revoke 的统一生命周期 + loading/ready/failed 状态。AvatarImage / StaffAvatar / AssetImage / MediaImage 直接消费；VoiceMessage 用 onResponse 门控（audio/silk）+ onBlob 回调（Audio 装配）；MediaFile 的流式下载是独立机制不并入 |

## 工作台（support-web）机制模块与依赖方向

视图（`views/ConversationsV2.vue`，约 550 行）只做组装接线与模板编排，
状态与逻辑全部在模块里；依赖单向：

```
use-transcript-scroll ─┐
use-conversation-inspector ─┤
use-conversation-list ─┼─→ use-conversation-selection ─→ use-conversation-actions
use-conversation-realtime ─┘        （列表/实时经回调回调进视图接线）
use-contact-list（工作台 + WhitelistView 共用）
```

- **use-conversation-selection**：选中 → 6 路并发详情装载 → 代际检查
  （selectionGeneration）→ 就地替换；增量转录刷新（append + 就地 patch）、
  静默上下文刷新、更早消息分页（滚动锚定）。快速切换会话时旧响应必须丢弃。
- **use-conversation-actions**：全部写操作（接管三态/转交/发送/重试/
  结果查证/上传/拍一拍/@提及）。
- **use-conversation-list**：三区队列 + 游标续页 + Console 能力门。
- profile 的拉取由 selection 并发装载调用（inspector.fetchProfile），
  代际检查通过后经 applyProfile 落位——旧资料绝不写入新会话。

## 已固化的决定（2026-09-09）

1. **prompts.json 机制整体删除**（原「运行时热改覆盖」与 BFF
   `/customer-support/prompts` 排障端点一并移除）。提示词权威顺序：
   AI 员工已发布版本（DB，`ai_employee_versions`）> 内置客服提示词。
   改提示词走 AI 员工版本管理（support-web 设置中心）。
2. **BFF 只保留鉴权面**：AI 员工管理（/api/v1/agent/ai-employees 等）+
   会话只读投影（session-state / decision-trace / turn-outcomes /
   session-wakes / live-turn）。原 4 条未鉴权 /customer-support/* 路由
   （裸读消息原文，经 api.leaif.com 公网可达）与 echo 端点已删除。
3. **插件导出面收窄为 4 个**（与 agent-worker 消费面精确一致）：
   `strategy`（静态，仅内置提示词）、`createStrategy`、
   `preResolveAiEmployeePrompt`、`getCachedAiEmployeeId`。
   员工解析合并为单次成对解析（employeeId + prompt 同查同缓存），
   任何失败 fail-open 回落内置提示词；两个 TTL 缓存（员工 5min /
   群聊附加指令 30s）可注入假时钟隔离测试。
4. **提示词字节级 golden 快照**：`tests/goldens/prompts.json` +
   `tests/prompt.test.ts` 钉死两条提示词路径的 12 个渲染变体；
   有意变更协议时先 `npm run build && node scripts/render-golden-prompts.ts`
   重新固化，评审后合入。
5. **Composer 图片/文件发送修复**：原实现 `@change` 信号被视图代理层
   吞掉，`onImagePicked/onFilePicked`（上传+发送）从未被调用（图片/文件
   选择后静默丢失）。现 `pick-image/pick-file` 事件携带 DOM Event 一路
   透传，直接绑定上传发送逻辑。

## 测试入口

- support-web：`pnpm --dir solutions/customer-support/apps/support-web test`
  （vitest，35 例：handoff-vocab / transcript-merge / use-contact-list /
  use-conversation-realtime）
- 插件：`pnpm --dir solutions/customer-support/plugins/customer-support-strategy test`
  （tsc 构建 + node:test，31 例：parser 全动作矩阵 / golden 字节级 /
  解析优先级与 TTL 缓存）
- 提交前：`pnpm build`（根）覆盖插件与 support-web 构建。
