# Weflow Console — Release Checklist

> 每次改动 Shell / Strategy / Knowledge / CSS / Overlay 后必须重跑本清单。
> 状态三态：`✓ Verified` / `⚠ Manual verification pending` / `✕ Broken`。
> 核心规则：**美化不得牺牲可发现性、可逆性与真实可用性。**

## 必测项

### 1. Sidebar
- [ ] expand → collapse → expand（真实点击）
- [ ] collapse 状态下「展开侧栏」按钮始终可见（可点击/可键盘 focus/有 aria-label）
- [ ] collapse 后刷新页面 → 仍可展开

### 2. Customer Service
- [ ] 打开会话 → 阅读 → 接手/领取 → 输入回复 → 发送
- [ ] 查看交接 Drawer → 关闭（× / backdrop / Esc）
- [ ] 转交处理 → 取消 → 再打开（无残留状态）

### 3. Knowledge
- [ ] validate：输入问题 → 验证 → 证据 → 打开来源 → 返回
- [ ] content：KB 切换 / 搜索 / 筛选 / 行点击 → Preview → Chunk
- [ ] 上传后解析状态自动更新（无需刷新）
- [ ] datasource/config：admin 可见、operator 隐藏

### 4. Strategy
- [ ] 空态 → 新建草稿 → 编辑器 → 取消 → 再打开 → 保存
- [ ] 版本栏切换 / URL versionId 同步 / 编辑 / 运行验证 / 失败案例 / 发布 gate / 发布确认弹窗 → 取消
- [ ] operator：只见摘要/空态，无编辑入口

### 5. Operations
- [ ] Kill Switch 控件可见（Agent 总开关 + 影响说明）
- [ ] 操作前 confirm 出现 → Cancel → 状态不变

### 6. Overlay（Drawer / Modal / Popover）
- [ ] 打开 → Esc → 关闭 → focus 回触发元素
- [ ] 显式关闭入口（× / backdrop）可用

### 7. Command Palette
- [ ] Ctrl/Cmd+K → 打开 → 输入 → Enter 跳转 → Esc → 关闭

### 8. Permissions
- [ ] admin / operator 分别访问全部页面（入口、按钮、菜单、API 一致）

## 回归记录

| 日期 | 改动范围 | 结果 | 备注 |
| --- | --- | --- | --- |
| 2026-08-12 | Release Gate 修复（Sidebar 展开/Strategy 空态建稿/Kill Switch 作用域/Esc 统一/Operations 分层） | Sidebar ✓；Strategy UI 发布路径 ✓（真实 passing run 受环境 LLM/worker 限制 ⚠）；Kill Switch 可见 ✓（confirm 实点 ⚠）；Esc ⚠（键盘管道）；Knowledge 轮询代码 ✓（ingestion 环境 ⚠） | 测试残留已清（策略/案例/run/qa_operator=0）；SMOKE_TESTS.md 并入本清单 |
| 2026-08-12 | P0: Registry 三层事实+productState；Server2 retrieval-settings 显式端点（白名单+read-modify-write+3 测试）；Config 真实值接线 | Registry 5 态派生 ✓（浏览器 Config 显示）；retrieval GET/PUT 实测（写生效+未知字段拒绝+恢复）✓；Server 30 测试通过 ✓ | Config 检索行显示真实配置，可保存 |
| 2026-08-12 | P1: 图片消息（结构化 contentType/mediaId+Blob+revoke+会话权限绑定验证）；发送 failed/unknown（自动查一次+禁重发+重试幂等）；转交 V2（客服/队列分组+原因+revision+拒绝按钮+transfer_pending 展示） | 图片渲染 ✓（fallback 正常）；Agent failed 无重试 ✓；人工 failed/unknown 按钮 ⚠（需真实发送失败场景）；转交弹窗 UI ⚠（点击管道）+ 合同实测 ✓（Server2 transfer-preview/transfer/reject-transfer/handoff-targets/queues 全部 200） | 真实转交链未执行（避免动生产会话归属），待隔离环境人工验证 |
| 2026-08-12 | P2: 消息 cursor 分页+scroll anchoring（加载更早消息后视口锚定不动）；新消息跟随（72px 阈值+未读计数+回到底部按钮）；Handoff Cycle 历史时间线（brief drawer） | 分页代码 ✓（nextCursor+firstVisibleMessageId+restoreAnchor）；跟随 ✓；时间线 ✓；浏览器交互 ⚠（点击管道受限） | 需长会话（>1 页消息）人工回归 |
| 2026-08-12 | P3: Feedback 三入口（turn 需复盘/brief 摘要有误/消息标记需复盘+模板按钮） | 构建 ✓ built in 1.45s；端点合同复用既有 Server2 POST（turn-feedback/brief-feedback/review-feedback）✓ 代码路径 | 按钮交互 ⚠（点击管道）；反馈写入验证待人工 |
| 2026-08-12 | P4: Knowledge 接线只读版（datasource/models/vector-stores/storage-backends 四清单+per-KB 绑定关系；registry 四项 missing→partial→read_only）；**修复 P0.2 遗留 bug：registry 非响应式（update 后 computed 不重算，检索状态永远停在基线「暂不可用」）** | 上游实测：datasource 单数+需 kb_id / models 复数 200×4 / vector-stores 复数 200（PostgreSQL readonly）/ storage-backends 复数 200（System LOCAL+default_storage_backend_id）✓；浏览器验证：配置页检索「可用」✓（修复生效）、能力状态四项「只读」✓、模型列表 4 条真实数据 ✓、向量库/存储列表 ✓、数据源页「只读」✓；数据源绑定关系展开 ⚠（管道故障）；`pnpm build` ✓ 1.51s | registry 响应式修复（shallowRef revision）需全站回归：Operations/Knowledge 所有消费 registry 状态行的页面 |
| 2026-08-12 | **RC Verification**：转交真实状态机（API 驱动）/ failed-unknown 人为制造 / 图片真实消息 / 分页 cursor / registry 响应式回归 | **转交两链全绿** ✓：领取→TRANSFER_PENDING→接受→owner 真变化（rev 8→10）；转队列→HANDOFF_PENDING→成员领取→resolve（rev 11→12），环境已还原；**P1.3 状态契约 Bug 修复** ✓（mobile 大写状态 vs 前端小写比较→领取/transfer_pending/mine 全失效；ConversationsV2+旧版 normalize；resolved→接手按钮 / transfer_pending 提示条浏览器只读验证）；**P2.1 cursor Bug 修复** ✓（前端传 cursor= 而服务端要 before=→分页 100% 重叠；改后 287 条 3 页无重叠无遗漏）；failed/unknown DOM 验证 ✓（发送失败+重试 / 结果未知+查询结果 / 禁重发 / 自动查一次）；图片 ✓（ready→blob URL 渲染 / failed+坏 id→fallback）；registry 消费点静态审查 ✓（检索行自动升级浏览器验证）| **环境阻塞**：浏览器动作通道（点击/滚动/输入）broker 死锁，穷尽内部恢复无效 → 图片全屏、重试/查询结果点击、滚动锚定肉眼确认、转交弹窗点击待环境重启后补验（均为 ⚠，代码+DOM+API 证据已备）；**记录 2 项非阻塞发现**：① 媒体 /content 仅登录校验无会话级绑定（宽松，待产品决策）；② take-over 后转交需 briefing v2（状态机正确约束，前端转交按钮未做前置提示） |
| 2026-08-12 | **UX Unification 第一轮核心链**（Simple Super-App）：P0 术语统一 / P1 WfInspector / P2 Shell 三组导航 / P3 客户服务三栏标杆 / P4 Overview / P5 Coach 接活+删旧版 | **术语统一** ✓（等待接手/接手处理/我处理中/标记需复盘/仍需确认/影子案例/草稿-已发布-已归档中文 badge/风险词 高风险-需关注-常规）；**WfInspector** ✓（360px 静态第三栏，<1240 变 drawer 浮层，Esc+焦点归还，层级返回）；**三栏客户服务** ✓（Inbox/Conversation/Inspector；Inspector 默认当前上下文：任务/交接摘要/关键事实/依据/联系人/交接历史，点击进深度视图；浏览器只读验证渲染）；**Shell** ✓（工作/Agent/管理 三组；改进=影子验证 admin；aria 补齐）；**Coach 接活** ✓（/agent/coach→CoachV2，浏览器验证渲染；术语影子案例）；**删旧版** ✓（OverviewView/ConversationsView/KnowledgeView/PoliciesView/CoachView/RuntimeView/KnowledgeValidateView/KnowledgeEngineView/ConsoleShell/route-flags 全部删除，构建通过；知识引擎「代理安全边界」说明已迁移至 SystemStatusView 不丢能力）| **Server Contract Issue（暂缓）**：「建议回复」Server2 无 copilot/suggest 端点（移动端 use-copilot 可对齐），Client2 不渲染假 UI，待后端支持后接入（采用→Composer 可编辑/流式）；⚠ 深度视图切换/Inspector 返回键点击待环境重启后验证；AuditView/Knowledge 的 drawer 迁移至 WfInspector 留第二轮 |
| 2026-08-12 | **UX Unification 第二轮**（drawer 统一迁移 + 策略首屏 + 纪律审查）：AuditView 事件详情 / KnowledgeContent 标签+活动记录 / KnowledgeWiki 阅读 / KnowledgePreviewDrawer 预览+切片 全部 drawer → WfInspector（新增 overlay 变体+actions 插槽）；PoliciesV2 首屏「当前线上/正在验证/草稿」生效状态总览 | **WfInspector overlay 变体** ✓（单列页面固定浮层+backdrop；actions 插槽供 更多/返回会话/编辑 自定义操作）；**四组件迁移** ✓（AuditView/KnowledgeContent×2/KnowledgeWiki/KnowledgePreviewDrawer，构建通过）；**策略首屏总览** ✓（浏览器验证：当前线上/正在验证/草稿 三行+badge，空态「建立第一份草稿，验证通过后再发布」）；**纪律审查** ✓（Confirm 全部合规：删除/重解析/结束人工/拒绝转交/Kill Switch/撤销 Session/重置密码/禁用账号有确认+审计提示，普通操作无多余确认；Empty 三要素基本满足；会话行 reason+risk 双 badge 属不同维度；Error 单点已符合）；浏览器回归 ✓（审计页/知识内容页渲染正常） | ⚠ 事件详情打开/标签管理/活动记录/预览 drawer 的交互点击待动作通道恢复后补验（迁移结构已 DOM 验证）；AuditView 事件行点击渲染 Inspector 的最终目检待环境 |
| 2026-08-12 | **第三轮 Workspace Stabilization + Knowledge Power-Up**：P0 真实浏览器几何审计 / P1 客户服务（三栏比例+增量刷新）/ P1.2 实时审计 / P3 布局 / P2 WeKnora 调研（Preview 降级+Wiki 树）/ P5 Contact History | **Root Causes**：① Inspector 在 .wf-cs-layout 外（非第三列+container query 失效）→ 已移入（1440 三栏 queue288/thread563/inspector340；1366/1280 Inspector 转 overlay 浮层；全部无溢出）；② wf-config-summary 720px 靠左 → margin-inline auto 居中；③ **刷新根因**：5s timer→checkForNewMessages→select() 全量重载（Skeleton 闪烁+Inspector 重置+图片重载）→ 改为**增量 append**（稳定 messageId 去重）+ 静默上下文刷新 + focus 立即刷新 + 跨 timer 实测无骨架闪烁 ✓；**Preview 矩阵实测**：PDF→原始 PDF 流（iframe 内嵌✓）/ PPTX→原始 octet-stream（无转换→**降级「原始预览不可用，已解析内容仍可阅读」+chunks 文本**）/ HTML→502 上游拒绝（同降级）/ DOCX/MD 待样本；PDF 定位命中页=上游无页码元数据（边界记录）；**Wiki 矩阵实测**：pages/version/in_links/out_links/source_refs 齐全，无 tree 端点 → **wiki_path 树形缩进**（不发明模型）；**Contact History** ✓（?contactId= 契约实测 5 会话；Inspector 内历史列表+只读消息流，depth 层级返回） | **Server Contract Gap（记录）**：Server2 无会话级实时事件流（SSE 仅知识问答流式），前端不伪造实时——polling 5s 为唯一事实源（safety net）+ 增量刷新保证不闪烁；「建议回复」同前暂缓；⚠ 深度视图/历史会话点击待动作通道恢复目检；DOCX/MD/TXT preview 待真实样本验证；PDF 页定位待上游支持页码元数据 |
| 2026-08-12 | **第四轮 Dynamic UX 收口**：动作通道验收 / 真实样本能力矩阵 / **Core SSE 事件流** / **Suggestion 合同** / Race-condition 保护 | **R4-① 真实点击验收** ✓（动作通道恢复：Inspector Context→Brief/Evidence/Contact→历史列表→只读消息流→返回键层级→×关闭 width0 真关+会话保持；Esc ⚠ 键盘送达受限代码已审查）；**R4-② 样本矩阵实测** ✓（test.md→preview text/markdown 原始文本+**mini-markdown 渲染**（#18 heading/table/code/list）；test.txt→text/plain；test.docx→原始 docx 字节→parsedFallback 降级；test.pptx→上传解析 failed（最小样本结构不被上游接受，记录）+preview 原始字节；矩阵：PDF 原生✓ / MD/TXT 原生文本✓ / DOCX 降级解析文本✓ / PPTX 视解析而定）；**R4-③ SSE 事件流** ✓（Core GET /api/v1/console/events/stream + 事件总线 + 三发布点（人工回复/客户消息/handoff transitions）+ 25s 心跳；前端 EventSource 订阅 + **realtime 60s 对账 / 断开 5s fallback / focus 立即刷新**；端到端实测：发消息→浏览器队列自动更新且当前会话视图不受影响）；**R4-④ Suggestion** ✓（Core POST /conversations/:id/suggestion 复用知识问答管线收集版，实测 200/7s 返回 suggestionId/text/evidenceIds；UI：建议回复卡片（依据 N/采用/忽略/重新生成）+ 采用→Composer 可编辑+光标插入；采用点击 ⚠ 管道送达（同卡片忽略按钮工作→事件系统正常，adoptSuggestion 代码审查正确））；**R4-⑤ Race 保护** ✓（selectionGeneration 代际检查 + 增量/上下文/建议函数绑定 conversationId；浏览器快速切会话实测无旧数据覆盖） | Core Contract 新增：conversation SSE 事件流 + suggestion 端点（均为本轮实测）；⚠ 采用按钮点击、Esc 键盘送达待环境；Suggestion 流式 delta（suggestion_delta）为后续扩展（当前同步返回，不造假流式）；事件流为进程内总线（多实例部署需迁移 LISTEN/NOTIFY） |
| 2026-08-12 | **管理员体验修复（审计驱动）**：F1 数据保护 / F2 闭环 / F3 配置治理 / F4 信息一致性 | **F1** ✓：检索配置加载失败禁用保存+保存前 diff 确认（列出改动字段）+成功提示；上传轮询 3 分钟硬停→30 分钟延续+超时提示+上传成功 notice；错误码映射 17 条（handoff/媒体/生成/会话白名单化）；**F2** ✓：**反馈→候选→审核→影子基准闭环打通**（Server2 新增 POST /coach/cases/:caseId/verify-redaction（candidate+needs_review→verified+reviewed，audit）；CoachV2 候选案例区（待审核 badge+标记脱敏已审核+加入影子基准）；**端到端实测**：turn-feedback→候选池显示→审核→promote→DB zone=holdout）；用户搜索（账号/角色）+初始密码一键复制；**F3** ✓：rerank_model_id 裸输入框→**模型选择器**（4 模型+未设置选项）；数据源绑定明细补 sync_status/last_sync_at；**F4** ✓：未就绪计数排除 read_only（5→1，浏览器实测）；能力开关（知识/记忆/图片理解）加 confirm；/agent/coach 路由补 meta.admin + KnowledgeV2 adminOnly mode 客户端守卫；活动记录 403 如实显示（不再伪装"暂无记录"）；模型行补维度/日期、存储补更新时间；审计时间范围筛选（Server2 from/to 参数+前端日期选择，实测 200）；检索 6 字段加语义说明（默认值提示）；解析死胡同加指引文案 | ⚠ 采用按钮/Esc 键盘送达仍待环境（非代码）；审计筛选后端 from/to 已实测；QA 密码临时重置已还原（hash 恢复） |
| 2026-08-12 | **气泡遗留修复**：composer 视野外 P0 / 骨架 / long 规则 / failed 验证 | **P0 根因**：.wf-cs-layout grid 无 grid-template-rows → 行高 auto；.wf-thread height:100% 在 grid 子元素解析失败 → thread 按内容高度溢出（实测 thread 1152 vs cs-layout 783，composer 被推出视口）→ 修复：grid-template-rows: minmax(0,1fr) + thread min-height:0；**composer 可见性复验** ✓（1440 视口 bottom 884 固定底部；messages 滚动区 269-748 衔接；Rior pending 会话 placeholder「先领取会话」）；**骨架样式** ✓（wf-message 类删除后补气泡形态 skeleton）；**failed 验证** ✓（构造 failed 人工消息：me failed 类+红框规则+「发送失败」常驻+重试按钮）；**长串换行** ✓（116 字符 URL break-word 无溢出）；**long 规则** ✓（152 字符消息触发 .wf-bubble.long max-width 82%）；图片贴边/unknown 常驻/接管条语义（服务端 canManualTakeover 驱动，Leaif 显示接管条为正确状态）全部确认；测试消息清理还原 | ⚠ hover 悬停目检（cua.move 未送达；:hover/:focus-within 规则代码审查正确） |
| 2026-08-12 | **客户服务消息流微信式气泡改造**（正文最高视觉权重；纯视图层） | **气泡化** ✓（bubble-row them/me：客户左侧白底、Agent 右侧品牌色 10% 浅底、人工右侧品牌色实底；meta 降噪：客户仅时间/Agent·时间/人工·username·时间）；**状态降噪** ✓（正常 sent/confirmed 不显示；仅 sending/failed/unknown 显示，failed/unknown 红色常驻——Rior 会话真实 unknown 消息实测「结果未知」常驻+查询结果按钮）；**操作按需** ✓（正常 hover/focus-within 出现；键盘 focus 可达；failed/unknown 状态文字不依赖 hover）；**宽度动态** ✓（普通 72%/长文本>144 字符 82%/图片 300px 贴边 padding 3px；1440 三栏/1366 wrap 72%/1100 窄屏 wrap 80% 三档实测无溢出）；**图片气泡** ✓（media 类贴边+圆角，实测 2 张渲染）；**system 事件保持 divider** ✓；分页锚定/增量刷新/状态机全部保留；构建全绿 | ⚠ hover 悬停目检（cua.move 未送达；CSS :hover/:focus-within 规则代码审查正确）待环境；「其他客服」为历史他人人工消息的诚实标签（无名字映射） |
| 2026-08-12 | **优先项收口**：治理 UI 补验 / 策略回滚+版本对比 / 数据源 Gap 确认 / CHANGELOG | **治理 UI 补验** ✓（动作通道恢复：模型列表维度 4096+删除按钮、新建模型 modal、**创建闭环**（ui-e2e-probe 入列+modal 关闭）；删除 confirm 链路 ⚠ 管道波动，API 层 DELETE 双验 {deleted:true}；残留清理还原 4 模型）；**策略回滚** ✓（Server2 POST /reply-policies/:id/rollback：retired 曾发布版本恢复 published+审计 reply_policy.rolled_back；实测 400 UUID 校验/409 policy_not_rollbackable；PoliciesV2 已归档行「回滚为线上」confirm 按钮）；**版本对比** ✓（双版本内容 diff 面板：品牌语气/人工衔接/回复边界/业务指引四字段 A↔B 对比，版本行「对比」toggle）；**数据源写入=Server Contract Gap**（上游 POST /datasource kb_id 传法不明、无同步/日志端点——不造假入口，保持只读）；**CHANGELOG.md** ✓（v0.5→v0.9 版本化记录）；构建全绿 | ⚠ 治理删除按钮 confirm 的浏览器点击、Esc 键盘送达待环境；数据源写入待上游明确契约 |
| 2026-08-12 | **模型/向量库/存储治理**（受控端点替代透传代理 + 管理 UI） | **上游契约实测** ✓：POST /models（name/type/source 必填；带 parameters 会挂起→创建仅基础字段）；DELETE /models/:id ✓；POST /vector-stores（name/engine_type）+ /vector-stores/test（TestStoreRequest）✓；POST /storage-backends（name/provider）✓；**无模型测试端点**；PUT 全量替换语义（危险，不做编辑）；**Server2 受控端点** ✓（schema 校验+错误白名单化 governance_not_found/invalid/conflict）：POST/DELETE /api/v1/admin/knowledge-models、POST /knowledge-vector-stores + /test、POST /knowledge-storage-backends；**实测**：创建模型 201（data 包装）、401 鉴权、测试连接透传上游结果（"connection test not supported for engine type: postgres"如实展示）、存储无效 provider→governance_invalid、**治理 DELETE 端到端**（{deleted:true} + 模型清单还原）；**前端 UI** ✓（KnowledgeConfig：模型区+新建模型按钮/非默认非内置行删除按钮（confirm+审计提示）、向量库区+新建/测试连接（结果展示）、存储区+新建、创建表单 modal（类型/来源/引擎/提供方下拉）；registry 三项 partial→**implemented（available）**）；构建全绿 | ⚠ 浏览器 UI 点击验证受限（动作通道再次退化；API 层创建/删除/测试/鉴权/错误映射全部实测，UI 代码审查+构建通过）；模型创建暂不支持参数/凭据配置（上游边界，UI 已注明）；编辑能力未开放（PUT 全量替换风险，标注） |
