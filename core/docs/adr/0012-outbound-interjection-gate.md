# ADR 0012：发送期插话闸门——出站分段落库不等于必发

- 状态：已接受（2026-09-09）
- 关联：ADR-0001（Agent Turn 执行 seam）、ADR-0006（群聊回复提及策略）、
  `outbound-step-decision.ts`（出站纯决策核）、`decision-disposition.ts`
  （吸收式回合矩阵）、`send-states.ts`（held 终态语义）

## 背景

Agent 回复以批次（`reply_batch_id`）落库，由出站轮询逐段发送（打字节拍
0.9–7.2s/段，8 段最长约 1 分钟）。分段一旦落库即「必发」：发送期间客户
插话（「等等，不对」「不用发了」）对流水线完全不可见，剩余分段照发——
与定时消息、会话唤醒「入站即作废」的语义不对称（ingest 侧
`cancelPendingScheduledSendsOnInbound` / `cancelPendingSessionWakesOnInbound`）。

系统对插话的感知能力原本不对称：

- **思考期**（决策未落库）：吸收式回合覆盖（superseded → absorbed_into，
  按 discard / commit-as-step / carry-through 矩阵分流）；
- **发送期**（已落库、逐段发出中）：零感知。

决策层本身已是 ReAct（工具检查点 + 续步循环），缺的只是把「眼睛」接到
发送流水线上。

## 决策

1. **闸门位置**：出站循环发送每一段 agent 回复分段前，检查该批次落库
   之后是否出现未处理新入站。命中 → 本段及剩余分段置 `held` 终态
   （`send_error = 'customer_interjection'`），并发布 `reply_interrupted`
   会话事件（跨进程 SSE 可见；每批至多发布一次）。
2. **插话锚点 = 批次落库时刻（分段 createdAt）**，而非触发消息时刻：
   吸收机制保证「落库前」的插话已并入最终决策（discard → 含插话重新
   决策后才落库），落库后的入站才是未处理插话。该锚点不会把已吸收的
   插话误判第二次，且无需 join `agent_turns`。查询同时要求
   `occurred_at > 锚点`（排除历史回填：回填行 createdAt 新但 occurredAt 旧）
   与 `is_self = false`（排除本账号 echo 与同账号人工代发）。
3. **应变交给既有新 turn 机制**：插话消息自然触发新 Agent Turn，其上下文
   含插话内容、已送达分段与「被扣留分段提示块」（agent-context 渲染，
   24h 可见性窗口，与 cancelled 定时消息同一模式），由模型自由决定改写
   重发 / 原样补发 / 放弃。不新增模型调用路径、不新增进程或队列。
   重复收口由既有 `isDuplicateOfLastReply` 兜底，防双发。
4. **豁免矩阵**（表驱动纯函数 `interjectionGate`）：
   - 非 agent 批次（human/system、`handoff-farewell:`）：永不扣留；
   - `:tool-result` 变体：携带不可再生的工具结论，照发
     （对齐吸收矩阵 carry-through 语义）；
   - 群聊：仅**原提问者**（触发消息 actorId）的新消息才扣留——路人闲聊
     不扣，否则嘈杂群里回复永远发不完；wake 轮（`turn:wake:*`，无触发者
     基准）保守不扣；私聊任何新入站都扣。
5. **开关**：runtime settings 新增 `outbound_interject_gate_enabled`
   （**出厂默认 ON**——2026-09-09 拍板，未配置该键的部署/测试直接获得
   应变能力；需要旧盲发行为时显式置 false）。发送边界安全开关，与
   `auto_send_enabled` 同级同模式：fresh 读、审计、回滚、运营面板自动
   获得。逐段扣留跨轮询 pass 生效，与既有顺序闸门（blocked/pacing）
   协同，不改变其语义。
6. **上下文送达事实标注**：20 条原文窗口内，未送达（非 confirmed/observed）
   的出站消息渲染为「…（未送达）」——修复 sendState 洞：排队/被扣留分段
   不得冒充「已说出口的话」，否则新决策会引用对方还没收到的内容。

## 边界（诚实声明）

- **观察粒度是段，不是字**：打字节拍期间同段内无法中断；真人打字中间
  那句同样收不回来。
- **扣留是终态**（复用 kill switch held 语义）：不自动补发；是否重说由
  新 turn 的模型决策承担。插话后若无新 turn 触发（如联系人被停用），
  扣留分段静默沉淀——与 kill switch held 行为一致。
- 群聊误扣风险由「触发者限定」收窄；实测仍频繁误扣时可整体关闭开关。

## 后续方向（未排期）

- support-web / mobile 的「回复被插话打断」状态展示（消费
  `reply_interrupted` 事件）；
- mention 检测扩展群聊扣留条件（当前仅触发者）；
- 决策协议收敛（9 个 next_action → 说话/工具/handoff 三类）——独立改动，
  与本闸门正交。
