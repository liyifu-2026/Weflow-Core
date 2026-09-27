# 05 · API 接口全集

> 基址 `/api/v1`。鉴权：业务路由 `requireBusinessIdentity`（operator/admin 皆可），
> 管理路由 `requireAdminIdentity`（仅 admin）。鉴权方式：Web = Cookie 会话
> （`SESSION_COOKIE_SECURE` 控制是否 Secure）；手机端 = `Authorization: Bearer <token>`。
> 全部输入经 zod 校验；写操作普遍带 `clientRequestId` 幂等键。
> 出处：各模块 `interface/http-routes.ts` 与三端 API 客户端源码。

## 0. 约定

- 错误响应：非 2xx 返回 `{ "error": "<错误码>" }`（前端 `errorCopy()` 把数十个服务端错误码
  映射为中文文案，完整清单以 `support-web/src/api.ts` 的 `errorCopy()` 为准）。
- 分页：多数列表用**游标**（`?limit=&before=<cursor>`，keyset）；admin 列表用页码。
- 幂等：所有 Handoff 操作、人工回复、协作操作、记忆操作带 `clientRequestId`；
  服务端 `handoff.events` 存 request_hash + response_snapshot 支持重放。
- Channel Host 侧端点（43123）见 07 章，不在本表。

## 1. 认证与账号（identity）

| 方法 路径 | 鉴权 | 用途 |
|-----------|------|------|
| POST `/auth/login` | 公开 | Web 登录（Set-Cookie；限流 10 次/15min 双维度） |
| POST `/mobile/auth/login` | 公开 | 移动端登录（返回 sessionToken + user，长 TTL） |
| POST `/auth/logout` · `/mobile/auth/logout` | 登录 | 登出（移动版吊销 token） |
| POST `/auth/change-password` | 登录 | 改密 |
| GET `/auth/me` · PUT `/auth/me` | 登录 | 当前用户 / 更新 displayName、tags |
| GET `/auth/tag-vocabulary` | 登录 | 专家标签词表（与专家队列同源） |
| POST `/auth/avatar` | 登录 | multipart 上传头像 |
| PATCH `/auth/avatar` | 登录 | 选择/清除预设头像 `{preset}` |
| GET `/users/avatar-presets` | 登录 | 平台预设头像清单（DiceBear） |
| GET `/users/:userId/avatar` | 登录 | 用户头像 |
| GET `/avatars/dicebear/:style/:seed` | 登录 | 默认哈希头像 |

管理：`GET/POST /admin/users`、`PATCH /admin/users/:userId`（角色/状态/displayName），
`POST /admin/users/:userId/reset-password`、`POST /admin/users/:userId/revoke-sessions`。

## 2. 会话与消息（conversations）

| 方法 路径 | 用途 |
|-----------|------|
| GET `/conversations?scope=attention\|mine\|others\|all&limit&before` | 会话列表（三区队列；`all`=全部未拉黑，黑名单制 0078） |
| GET `/conversations/search?q=&limit=` | 会话+联系人联合搜索（q 按联系人展示名/昵称/备注/共享别名 ILIKE 模糊匹配，`query-conversations.ts`） |
| GET `/conversations/hidden` / POST `/conversations/:id/visibility` | 隐藏列表 / 设置隐藏 |
| GET `/conversations/:id/messages?limit&before` | 转录游标分页（最近 N 条向上翻页） |
| POST `/conversations/:id/messages` | **人工回复**：`{text, clientRequestId, expectedConversationRevision?, mediaId? \| media{fileId,kind}? \| assetId?, replyToChannelMessageId?, mentionContactRefs?}` |
| GET `/conversations/:id/messages/outcome?clientRequestId=` | 发送结果查询（`pending/accepted/sent/failed/unknown/held/cancelled/not_found`） |
| POST `/conversations/:id/read` | 标记已读 `{lastReadMessageId}` |
| POST `/conversations/:id/poke` | 拍一拍（需 handoff assignee；直接调 Host，不落本地消息） |
| GET `/console/capabilities` | 客户端能力协商（conversationPermissions 等） |
| POST `/admin/channel/sync` (admin) | 触发 Host 历史回溯重扫（异步） |

## 3. Handoff（人工转接）

| 方法 路径 | 用途 |
|-----------|------|
| GET `/conversations/:id/handoff` | 当前 Handoff 状态（404=无） |
| POST `/conversations/:id/handoff` | 创建（空 path transition；模型或人工发起） |
| POST `.../handoff/accept` | 认领（`expectedHandoffRevision` + clientRequestId，原子） |
| POST `.../handoff/take-over` | 人工接管/重新接管（409 竞争失败是正常结果） |
| POST `.../handoff/release` | 释放 |
| POST `.../handoff/transfer-preview` / `transfer` / `reject-transfer` | 转交预览/转交（targetType user\|queue）/ 拒收 |
| POST `.../handoff/resolve` | 解决（`{clientRequestId, summary}`；触发解决摘要作业） |
| GET `.../handoff/finish-context` / POST `.../handoff/finish` | 收尾上下文 / 收尾完成 |
| POST `.../handoff/brief-feedback` / `.../messages/:messageId/review-feedback` | 简报/消息质量反馈 |
| GET `/handoff-assignees` · `/handoff-targets/queues` | 可转交客服 / 专业队列 |
| GET `/mobile/capabilities` · `/mobile/handoffs/inbox` · `/mobile/request-outcomes` | 移动端能力/收件箱/操作结果 |

## 4. 联系人（contacts）

`GET /contacts`（q 搜索、agentEnabled/blocked 过滤、游标分页）、
`GET /contacts/:contactId/conversations`（历史会话）、
`GET/PATCH /conversations/:id/contact-profile`（note/tags/agentEnabled/scheduledSendEnabled/blocked）、
`GET /contacts/:contactId/avatar`（代理 + 缓存）。

## 5. Agent 运行时（agent）

| 方法 路径 | 用途 |
|-----------|------|
| GET `/agent/session-state/:conversationId` | 会话 Episode 状态（轮数/预算/状态） |
| GET `/agent/session-wakes/:conversationId` | 待触发唤醒 |
| GET `/agent/turn-outcomes/:conversationId` | 轮次体检（replied/no_reply/failed/in_flight） |
| GET `/agent/decision-trace/:turnId` | 决策轨迹（事件时间线 + 工具记录） |
| GET `/agent/live-turn/:conversationId` | 「AI 正在思考」实时轮询（前端 2s） |
| GET/POST `/agent/ai-employees`、PATCH `.../:definitionId`、POST `.../archive`、POST `.../versions`、PATCH `/agent/ai-employees/versions/:versionId`、POST `.../versions/:versionId/publish` / `/rollback` | AI 员工定义与版本管理（业务 BFF 域，详见 08 章 §2） |
| GET/PUT `/agent/workspace-default`、`GET/PUT/DELETE /agent/contact-bindings[...]` | 共享默认 / 联系人绑定 |
| GET `/scheduled-sends[?status=]`、`GET /conversations/:id/scheduled-sends` | 定时发送列表（全局/会话） |
| POST `/scheduled-sends/:id/cancel` / `/reschedule` / `/fire-now` | 取消/改期/立即发（frozen 禁代发） |

## 6. 媒体与素材（media / assets）

| 方法 路径 | 用途 |
|-----------|------|
| POST `/media` | multipart 上传（≤100MB；类型黑名单 `upload_type_blocked`→415）；返回 mediaId |
| GET `/media/:mediaId` | 元数据（mimeType/size/description=识图或转写文本） |
| GET `/media/:mediaId/content` | 派生内容（ETag=sha256、304、RFC5987 中文名） |
| GET `/media/:mediaId/content/original` | 全尺寸原图（未下载 → `media_original_not_found`） |
| GET/POST `/assets`、`GET/PATCH/DELETE /assets/:assetId`、`GET /assets/:assetId/content` | 素材空间 CRUD + 内容流（发送按 assetId 确定性派生 mediaId 不重传） |

## 7. 记忆（memory）

`GET/POST /conversations/:id/memories`（列表 / 人工创建修正）、
`POST /conversations/:id/memories/:memoryId/actions`（失效/确认，幂等）。

## 8. 知识（knowledge / knora-bridge / knowledge-provider）

- 客户端知识：`GET /knowledge/threads` 及 `/threads/:threadId/messages`、
  `GET /conversations/:id/knowledge/context`、`GET/PUT .../knowledge/evidence-tray`、
  `POST /knowledge/search`、`POST /conversations/:id/knowledge/retrieve` / `draft`、
  `POST /knowledge/feedback`、`POST /knowledge/answer/stream`（流式直答）+ `/answer/stop`、
  `POST /knowledge/chat`、`GET /knowledge/documents/:documentId[/preview|/content]`、
  `GET /knowledge/scopes` / `library` / `wiki-pages/content` / `images`。
- admin：`GET/PUT /admin/retrieval-settings`、`POST /conversations/:id/suggestion`（会话知识建议）。
- WeKnora 桥接：`POST /knora/launch`（一次性 code）、`GET /knora/redirect`（302 跳 WeKnora UI）、
  `POST /knora/exchange`、`POST /knora/bootstrap`（`KNORA_ACCOUNT_ENC_KEY` 缺失 → 503）。
- 白名单代理：`ALL /console/knowledge-provider/*`（support-web 知识页唯一上游通道，变更审计）；
  `GET /admin/knowledge-engine`（引擎体检）。

## 9. 协作（collaboration，存量收尾）

`GET /specialist-queues`、`GET/POST /conversations/:id/assistance-requests`、
`GET/POST .../escalations`、`POST /collaboration-requests/:id/claim|answer|close|cancel`（均幂等）。
手机端已不再新建，仅存量只读收尾。

## 10. 运营控制面（operations，admin）

| 方法 路径 | 用途 |
|-----------|------|
| GET `/system/status`（业务鉴权） | 服务健康矩阵 |
| GET `/admin/overview`、`GET /admin/runtime` | 管理总览 / 运行时信息 |
| GET `/admin/audit`、`GET /admin/audit/options` | 审计查询（事件类型/操作者/日期筛选） |
| GET `/admin/agent-turns` | 最近 Turn 诊断 |
| GET/PATCH `/admin/runtime-settings`、POST `.../rollback`、GET `.../audit` | 全局开关（Kill Switch 等 7 项）+ 回滚 + 审计 |
| GET `/admin/model-gateway`、PUT/DELETE `/admin/model-gateway/models/:modelId`、PUT `.../slots/:slot`、POST `.../test-connection` | 模型注册表 / 槽位绑定 / 连通性测试（热生效） |
| GET/PUT `/admin/solutions/:solutionId/extensions/:extensionId/settings` | 扩展设置读写（behavior/groupChat/knowledgeConnector） |
| GET `/admin/operator-status`、`/admin/runtime-console`、`/admin/console/home`、`GET /admin/stream`(SSE) | 运营台辅助端点 |

## 11. 通知（notifications，移动端）

`PUT /mobile/notification-device`（注册/更新：pushToken/platform/showPreview/notifyKinds）、
`DELETE /mobile/notification-device`、`PATCH /mobile/notification-preferences`（showPreview 或 notifyKinds；
空数组 = 恢复全部订阅）。

## 12. 实时与静态

- SSE：`GET /api/v1/console/events/stream`（网页端 Cookie / 手机端 Bearer + `accept: text/event-stream`）。
  帧格式为标准 SSE：`id: <eventId>`、`event: <事件类型>`、`data: <事件 JSON>`（空行分隔）；
  服务端周期发送注释帧 `: ping` 保活；事件负载结构见 02 章 §5。
- 健康端点：`/health/live`、`/health/ready`（3100/3101/3102 各进程）。
- 静态托管：非 `/api/`、`/health`、`/customer-support/` 前缀的 GET/HEAD 全部回落 `index.html`
  （SPA browser history；`/assets/*` 长缓存 immutable，index.html no-cache）。
  `/customer-support/` 是**保留前缀**（早期业务路由前缀的防御性保留，`web-static.ts`
  `RESERVED_PREFIXES`）；当前产品路由全部在 `/api/v1/*` 与 SPA 真实路径下，该前缀不影响
  browser history 路由（与「禁 `/support` 前缀」红线不冲突——那条红线针对 SPA 路由路径）。

## 13. 手机端完整调用清单（`@weflow/mobile`）

认证（§1）+ 能力协商 `GET /mobile/capabilities`（14 项能力门，404=旧 Core 全回退 false；
能力名清单见 10 章 §3）+
会话/Handoff（§2/§3）+ 媒体/素材（§6）+ 通知（§11）+ SSE（§12）。
移动专用：`POST /mobile/auth/login|logout`、`GET /mobile/handoffs/inbox`、
`GET /mobile/request-outcomes?operation=&clientRequestId=`。
HTTP 客户端：默认超时 20s；401 触发全局「认证失效 → 清 session → 回登录页」
（登录接口本身 401 除外，防死循环）。

## 14. 请求/响应示例与分页语义

**游标分页**：列表端点统一 `?limit=<n>&before=<cursor>`；`cursor` 是**不透明续页游标**
（取上一页响应中的 `nextCursor` 原样回传，客户端不得解析其内容）；响应含
`{ items, nextCursor, hasMore }` 形态字段（具体字段名以各端点 schema 为准）。

**登录（成功）**：

```http
POST /api/v1/auth/login
{"username":"admin","password":"********"}

200
{"user":{"userId":"<uuid>","username":"admin","role":"admin",
 "mustChangePassword":false,"displayName":"管理员","avatarUrl":"...","tags":[...]}}
Set-Cookie: weflow_session=...; HttpOnly; SameSite=Lax   /* Secure 视 SESSION_COOKIE_SECURE */
```

**登录（限流锁定）**：`429`（或 403，按实现）+ `{"error":"login_throttled"}` + `Retry-After: <秒>`。

**错误响应体**（统一形态）：

```json
{ "error": "handoff_already_claimed" }
```

**发人工回复**：

```http
POST /api/v1/conversations/<id>/messages
{"text":"重启之后再看一下。","clientRequestId":"7c9e...-uuid",
 "expectedConversationRevision":42}

202 → {"message":{...消息行...},"replayed":false,"conversationRevision":43,"contextChanged":false}
```

（`replayed=true` = 同 clientRequestId 幂等重放；`contextChanged` = 落库时会话上下文发生变化，
客户端应刷新会话。）

发送结果查询 `GET .../messages/outcome?clientRequestId=7c9e...` →
`{"outcome":"pending|accepted|sent|failed|unknown|held|cancelled|not_found"}`。

**Handoff 操作请求体**（全部幂等；409 族冲突码见 §15 附录）：

```http
POST .../handoff                      /* 创建（空 transition）*/
{"clientRequestId":"<uuid>"}

POST .../handoff/accept               /* 认领（原子）*/
{"clientRequestId":"<uuid>","expectedHandoffRevision":7}

POST .../handoff/transfer             /* 转交 */
{"clientRequestId":"<uuid>","targetType":"user|queue","targetId":"...",
 "transferReason":"需要硬件排查","sourceConversationRevision":42,
 "expectedHandoffRevision":7}

POST .../handoff/resolve              /* 解决 */
{"clientRequestId":"<uuid>","summary":"已指导重启并确认恢复"}
```

**全局开关修改**：`PATCH /api/v1/admin/runtime-settings`，body 为 7 个布尔字段的任意子集
（`agentEnabled / autoSendEnabled / knowledgeEnabled / memoryEnabled / visionEnabled /
mergeWindowEnabled / outboundInterjectGateEnabled`，键名与出厂值见 06 章 §13）。

**推送设备注册**：`PUT /api/v1/mobile/notification-device`，body
`{pushToken, platform:"android", showPreview?:boolean, notifyKinds?:string[]}`。

**模型注册/槽位**：`PUT /api/v1/admin/model-gateway/models/:modelId`，body 为模型定义
`{displayName, baseUrl, apiKey?, capabilities:["text"|"vision"|"asr"...], protocol, timeoutMs, failoverTo?, enabled}`；
槽位绑定 `PUT .../slots/:slot`（slot ∈ text/vision/asr/triage/fast）。`apiKey` 只写不读。

**会话列表**：`GET /api/v1/conversations?scope=attention&limit=100` →
`{"conversations":[{conversationId,contact{...},lastMessage{...},unreadCount,riskLevel,
handoff{status,...},agentSession{state,roundsUsed,roundBudget},revision}],"nextCursor":...,"hasMore":true}`。

**决策 JSON 完整示例**（模型输出，经策略闸门后处置——完整字段契约见 06 章 §5）：

```json
{"next_action":"reply",
 "reply_segments":["稍等，我看下后台。","你这个报错一般是加密狗没识别到。","重新插一下再试。"],
 "wait_ms":90000,
 "nudge_text":"插好了吗？",
 "risk_level":"low",
 "requires_human":false,
 "facts_card":{"problem":"加密狗不被识别","confirmed_facts":["错误码 E500"],
   "attempted":["重启"],"promises":[],"open_questions":["是否原装加密狗"]}}
```

（本节示例为**形态示意**：字段命名与可空性以各端点 zod schema 与客户端 `src/api/*.ts`
类型为准；示例本身不构成契约。）

## 15. 附录：服务端业务错误码 → 前端文案映射全集

以下为 `support-web/src/api.ts` `errorCopy()` 的完整映射（HTTP 语义层错误码；
Channel Host 协议错误码见 07 章 §2，contracts 包 `ERROR_CODES` 见 08 章 §5）：

| 错误码 | 场景 |
|--------|------|
| `request_timeout` | 客户端超时兜底 |
| `authentication_required` / `password_change_required` / `admin_required` / `operator_or_admin_required` | 认证与角色 |
| `invalid_request` / `invalid_cursor` | 请求与游标 |
| `conversation_not_found` / `handoff_not_found` / `thread_not_found` / `media_not_found` / `policy_not_found` / `assignee_not_found` | 资源不存在 |
| `handoff_not_assignee` / `handoff_already_claimed` / `invalid_handoff_transition` / `handoff_revision_conflict` / `conversation_revision_conflict` / `handoff_transfer_unavailable` | Handoff 并发与流转（409 族） |
| `media_not_ready` / `upload_too_large` / `upload_type_blocked` | 媒体状态与上传限制 |
| `knowledge_provider_unavailable` / `knowledge_provider_failed` / `knowledge_provider_rejected` / `knowledge_route_not_allowed` | 知识代理 |
| `generation_in_progress` / `generation_failed` / `knowledge_thread_not_found` | 知识生成/线程 |
| `avatar_unsupported_type` / `avatar_preset_unknown` / `invalid_display_name` | 资料与头像 |
| `ai_employee_key_exists` / `ai_employee_not_found` / `ai_employee_not_editable` / `ai_employee_not_archivable` / `ai_employee_not_versionable` / `ai_employee_version_not_editable` / `ai_employee_version_not_publishable` / `ai_employee_version_not_rollbackable` / `ai_employee_default_invalid` / `contact_agent_binding_invalid` | AI 员工与绑定（业务 BFF） |
| `case_not_promotable` / `policy_not_publishable` | 存量（Case/策略语义已随平台化退役，码保留） |

> 上表为映射关系速查；响应体统一形态见 §0。文案以 `errorCopy()` 当前版本为准。
