# ADR 0011：业务缺省出引擎——产品仓种子机制

- 状态：已接受（2026-09-09）
- 关联：宪法修正（根 AGENTS.md，2026-09-05：引擎层不加业务语义）、ADR-0002（策略与技能由插件提供）、ADR-0006（群聊策略机制放置）

## 背景

`core/modules/agent/application/behavior-settings.ts` 已确立 house pattern：
"引擎只消费数值与文本，缺省空/中立，业务话术由 `solution.extension_settings`
设置下发（fail-safe 逐项回落）"。但仍有四处业务缺省留在引擎代码里：

1. `group-chat-policy.ts`：`botNames: ["客服"]` 硬编码两处（DEFAULT 常量与
   extract 回落分支）；
2. `triage-classifier.ts`：`TRIAGE_SYSTEM_PROMPT` 整段客服预判话术硬编码；
3. `round-window.ts`：摘要行 `客户：…｜客服：` 角色标签硬编码（模型可见文本）；
4. `wx…${tail}` 发送者脱敏 ×3 与 tool 描述中的 wxid 措辞（微信语义泄漏进引擎）。

机制层本身已经是设置驱动的（mention 闸门、triage 规则、轮窗重建不动）——
残留的只是**缺省值与话术**。

## 决策

1. **引擎缺省一律中立**：
   - `botNames` 缺省 `[]`——语义 = 回落 Host `mentioned` fail-open 判定，
     恰是"未配置"的历史行为，无新增行为分支；
   - triage system prompt 进 `pipeline.triage.systemPrompt` 设置；未配置时
     LLM 分类层 fail-open 放行（规则层 `riskKeywords` 照常生效），引擎不再
     自备任何业务话术；
   - round-window 角色标签进 `behavior.roundSummaryLabels` 设置；引擎缺省
     中立 `customer` / `assistant`；
   - `wx…` 脱敏统一为一个渠道中立助手，tool 描述改"channel contact ref"措辞。
2. **载体 = 产品仓种子**：customer-support 的业务后端（BFF 插件）注册时
   **幂等 ensure** `extension_settings` 缺省——只补缺失键
   （ON CONFLICT DO NOTHING / 逐键补齐），**绝不覆盖用户已配置值**：
   - `groupChat.botNames = ["客服"]`
   - `pipeline.triage.systemPrompt =`（原 `TRIAGE_SYSTEM_PROMPT` 原文）
   - `behavior.roundSummaryLabels = { customer: "客户", agent: "客服" }`
3. **本部署模型可见字节不变**：种子值 = 今日硬编码值的逐字节拷贝。

## 不覆盖

- 机制放置不动：group-chat-policy / triage-classifier / round-window 仍留在
  `core/modules/agent/application`（ADR-0006 的放置决定不重开）——本次只搬
  词汇与缺省，不搬机制；
- 不新增"引擎集中缺省文件"或"设置中心强制配置"路径（曾被考虑并否决：
  前者宪法不纯，后者改变未配置部署的既有行为）。

## 后果

- fresh DB 由 BFF 首次注册自动种下业务缺省，无人工步骤、无部署顺序依赖
  （种子先于 ingest 消费：BFF 注册早于通道事件摄取）；
- 引擎可审计回归业务中立：`grep 客服 weflow/core` 归零（注释除外）；
- 将来任何人在引擎里找不到"缺省机器人昵称"时，本 ADR 说明这是刻意的——
  业务缺省的宿主是产品仓种子，不是引擎。
