# Mobile：移动人工客服工作台

Mobile 是 Agent → Human → Agent Handoff Console：Agent 无法继续可靠处理时，内部客服在手机上理解上下文、承担责任、处理或转交，并最终把控制权交还 Agent。

本地验证：`npm run test` 运行关键本地状态安全测试；提交前同时运行 `npm run typecheck`、`npm run lint` 和 `npx expo export --platform web`。

Core 是唯一业务入口和事实来源；Mobile 不连接 Channel Host、数据库、Redis、模型或 WeKnora。

## 已确认的产品决策

- 使用 Expo + React Native + TypeScript，同时支持 Android 与 iOS。
- 登录后直接进入唯一 Handoff Inbox，仅展示“等待接手”和“我处理中”两组工作状态。
- 人工接管采用独占接手：多个合法队列成员可收到提醒，但只有第一个原子接手成功的用户获得处理权。
- 任意时刻最多一个人拥有发送权限；所有接手、转交与结束动作由 Core 的 `handoffRevision` 原子裁决。
- 负责人可以结束人工处理，或通过统一“转交处理”流程转给具体客服或专业队列。
- Mobile 不提供独立知识库、模型、回复策略版本、协作工作台或系统管理功能；知识能力只作为当前会话内的隐形辅助。

## 范围

首版必须完成的闭环：

```text
登录 / 首次改密
  → Handoff Inbox（等待接手 / 我处理中）
  → 新 Handoff Push
  → 原子接手
  → Handoff Brief 与会话阅读
  → 人工回复
  → 结束人工处理并把控制权交还 Agent
```

首版不做群成员级 CRM、多人共同编辑、自动排班、主动触达、知识库管理、模型调试或完整经营报表。指定客服转交的超时 fallback 由 Core 自动处理，Mobile 不实现 SLA 或排班算法。

## 独占抢单规则

`Handoff` 是会话上的工单，不是普通聊天标签。

| Handoff 状态 | 谁可操作 | Mobile 行为 |
| --- | --- | --- |
| 无 | Agent 正常处理 | 会话可读；不可手工抢发 |
| `HANDOFF_PENDING` | 合法通用/专业队列成员 | 显示唯一主操作“接手处理” |
| `HUMAN_ACTIVE` | 仅 `assignedUserId` | 负责人可回复、转交处理或结束人工处理 |
| `TRANSFER_PENDING` | 仅目标客服可接受或拒绝 | 原负责人立即只读，目标客服尚未获得发送权限 |
| `HUMAN_FINISHED` | 无人继续人工处理 | 客户下一条消息重新由 Agent 处理 |

接手必须由 Core 原子完成：只有 `HANDOFF_PENDING` 且当前用户属于合法队列时才可进入 `HUMAN_ACTIVE`。并发情况下只允许一个请求成功。失败请求返回 `409 handoff_already_claimed` 和当前负责人摘要；App 立即刷新后按 Core 真实归属进入只读。

每次责任转移结束旧 Cycle 并原子创建携带不可变 Structured Handoff snapshot 的新 Cycle。Core 必须拒绝非负责人的发送、转交和结束动作；界面禁用只是体验优化。

## 页面与导航

没有底部导航。登录后唯一首页是 Handoff Inbox；客服头像打开个人与设备入口，会话详情通过 Inbox 进入。

### Handoff Inbox

- 只保留“等待接手”和“我处理中”两个分段。
- 每项突出联系人、问题摘要、转人工原因和等待时间；技术 ID、复杂 Badge 和模型状态不作为主要信息。
- 搜索默认收起，点击顶部搜索图标后打开。
- 收到 Push 或前台轮询发现变化时，刷新受影响会话而不是盲目重置整个列表。

### 会话详情

- 使用 Core 游标分页读取 transcript；按时间正序呈现客户、Agent、系统和人工消息。
- 显示消息发送状态：等待发送、发送中、已送达、状态未知/失败。禁止把 `pending` 当作客户已收到。
- 图片只通过受鉴权的 Core Media 内容接口加载，禁止保存 Channel Host 或本地文件路径。
- 仅负责人可见输入框；“＋”菜单只保留建议回复、转交处理和联系人资料，结束人工处理位于会话菜单。
- 人工发送采用本地 UUID 幂等键。网络失败后可重试同一请求，不能生成第二条消息。

### 联系人抽屉

- 只展示影响当前回答的必要资料，例如姓名、公司和设备型号。
- 完整资料作为次级 Sheet，不提供画像、价值、销售字段、Agent 配置或 Memory 管理。

### 个人抽屉与账号设置

- 当前登录用户、退出登录、修改密码和通知权限状态。
- 首次登录且 `mustChangePassword = true` 时，只允许进入修改密码或退出登录。

## 移动认证与安全

现有 Core 浏览器接口使用 Secure HttpOnly Cookie。原生 App 不应依赖浏览器 Cookie 行为。

Mobile 上线前，Core 增加移动端专用登录与注销接口，继续复用 PostgreSQL 的可撤销 Session 事实：

```text
POST /api/v1/mobile/auth/login
  → 返回一次性、不透明的 session token 与 user

Authorization: Bearer <opaque session token>
  → Core 查验其哈希、过期、用户状态和首次改密要求
```

- Token 不是 JWT，不在 Mobile 保存用户权限声明。
- Token 只写入 iOS Keychain / Android Keystore（Expo SecureStore），绝不写 AsyncStorage、日志、截图或 URL。
- 服务端可通过禁用用户、重置密码或注销立即吊销 Session。
- HTTPS 是唯一网络通道；生产 API 域名必须固定，禁止接受用户输入的任意 Server 地址。
- API 错误、Push 内容和本地通知不得包含客户完整对话、密码、会话 Token、模型提示词或内部错误堆栈。

## Push、刷新与离线

Push 是提醒，不是业务事实，也不是抢单凭据。

1. App 登录后注册设备安装信息和 Expo Push Token。
2. Core 创建 Handoff 后，向所有可用安装写入 `notification_outbox`。
3. 独立、可重试的通知投递器调用 Expo Push Service；投递结果与无效 Token 可审计。
4. 收到 Push 后，App 重新请求 Handoff / 会话状态；接手仍由 Core 原子裁决。

Push/realtime 仅作为 invalidate signal，前台轮询继续作为 safety net。离线 owner 可继续编辑按账号与 Cycle 隔离的安全草稿，但发送、接手、转交、结束和建议生成全部禁用。

## Core 契约：可直接复用

| 能力 | 当前接口 |
| --- | --- |
| Mobile capability | `GET /api/v1/mobile/capabilities` |
| 浏览器登录/当前用户/改密/退出 | `/api/v1/auth/login`、`/me`、`/change-password`、`/logout` |
| Mobile Handoff Inbox | `GET /api/v1/mobile/handoffs/inbox?limit=` |
| transcript 游标分页 | `GET /api/v1/conversations/:conversationId/messages?limit=&before=` |
| 创建人工消息 | `POST /api/v1/conversations/:conversationId/messages` |
| Handoff 查询、接手、转交、结束与 outcome | `/handoff`、`/accept`、`/transfer-preview`、`/transfer`、`/finish-context`、`/finish` 与 `/api/v1/mobile/request-outcomes` |
| 联系人资料 | `/api/v1/conversations/:conversationId/contact-profile` |
| Memory | `/api/v1/conversations/:conversationId/memories` |
| Media 元数据/内容 | `/api/v1/media/:mediaId`、`/content` |
| 移动 Push 与预览偏好 | `PUT /api/v1/mobile/notification-device`、`PATCH /api/v1/mobile/notification-preferences` |

## Core V2 合同

以下后端切片已经进入集成测试，且任何时候都不能以客户端逻辑代替。

1. **原子接手**：`POST .../handoff/accept` 使用 `HANDOFF_PENDING` 和 `expectedHandoffRevision` 条件更新；冲突返回 `handoff_already_claimed` 与当前负责人摘要。
2. **负责人授权**：人工回复、转交和结束人工处理均校验 `assignedUserId` 与 `expectedHandoffRevision`。
3. **责任转交**：转给客服进入 `TRANSFER_PENDING`；转给专业队列进入 `HANDOFF_PENDING`。两者都结束旧 Cycle 并原子创建带结构化快照的新 Cycle。
4. **专用 Inbox**：只返回合法队列的 `HANDOFF_PENDING`、当前用户的 `HUMAN_ACTIVE` 和以其为目标的 `TRANSFER_PENDING`，风险、等待时间和客户补充排序由 Core 提供。
5. **移动 Session**：增加 Bearer 不透明 Token 的签发、校验、注销和审计，复用现有服务端 Session 吊销语义。
6. **设备与通知**：新增设备安装、Push Token、通知 Outbox 和投递器；Token 失效可安全撤销，重复任务不重复推送同一 Handoff 事件。
7. **刷新信号（可选）**：第一版可只用轮询与 Push；若后续增加 SSE，必须按登录用户鉴权，事件仅携带资源 ID 和版本。
8. **超时 fallback**：指定客服转交默认 15 分钟接受窗口；`acceptBy` 和 `fallbackQueueId` 由 Core 给出，拒绝/超时进入 fallback queue。
9. **人工结果接续**：结束后异步生成 `resolutionSummary`；下一 Agent Turn 只继承结果、总结、最终事实、未解决事项和必要客户约束。

## 推荐目录

```text
apps/mobile/            # Customer Support Solution 内的 Mobile 应用
├── app/                 # Expo Router 路由与页面组合
├── src/
│   ├── api/             # 仅封装 Core HTTP 契约与错误映射
│   ├── auth/            # SecureStore Session 与登录状态
│   ├── conversations/   # 列表、transcript、人工发送
│   ├── handoffs/        # 接手、转交、结束人工处理
│   ├── notifications/   # Push 注册与前台刷新
│   ├── media/           # 受鉴权 Media 加载
│   └── ui/              # 无业务副作用的通用组件
├── docs/
│   └── acceptance.md
└── README.md
```

业务规则不得只藏在页面组件或 Zustand/Redux 状态中；客户端状态始终以 Core 响应为准。

## 验收标准

- 两台设备同时点击同一待接手 Handoff，恰好一台接手成功；另一台刷新后显示真实 owner 并变为只读。
- 非负责人即使伪造请求，也无法发送、完成或转交该 Handoff。
- 负责人发送同一 `clientRequestId` 两次，只产生一条人工出站消息。
- Handoff 创建时所有登记设备最多收到一条对应 Push；Push 延迟或重复不影响唯一负责人。
- 被禁用、改密或退出后的移动 Token 立即不可继续调用业务接口。
- 前后台切换、网络断开和发送失败不会伪造“已送达”状态或产生重复消息。
- iOS 与 Android 均覆盖登录、接手、人工回复、转交、结束人工处理和图片查看的真机回归。

## 开发顺序

1. Core 独占抢单与负责人授权测试。
2. Core 移动 Session 与设备/通知 Outbox。
3. Expo 项目骨架、登录/改密、网络层与安全存储。
4. 会话列表、筛选、详情 transcript 与人工发送。
5. Handoff 接手、只读限制、转交与结束人工处理。
6. Push、前台刷新、错误恢复和真机验收。

只有第 1、2 步稳定后，才应把 Mobile 接到真实微信会话，避免移动端抢单规则与 Core 事实不一致。
