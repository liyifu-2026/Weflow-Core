# 建议回复：安全合同与交互

建议回复是当前 Handoff 中的次级辅助，不是独立知识工作台。它只在当前客服已成为 owner 且 Core 发布 `structuredSuggestion` capability 后可用。

核心原则：

- 待接手状态不生成 Suggestion。
- Suggestion 和 Human Draft 是两个独立对象。
- Suggestion 只能被采用到草稿，永不自动发送。
- Conversation revision 改变后 Suggestion 立即 stale，只能手动重新生成。
- Core 负责建议内容、来源 revision、Evidence 权限与审计快照；Mobile 不补写事实或依据。

## Core 合同

```ts
type ReplySuggestion = {
  suggestionId: string;
  text: string;
  sourceRevision: number;
  generatedAt: string;
  evidenceIds: string[];
  generationStatus: "generating" | "ready" | "failed" | "stale";
};
```

知识型建议必须有 Evidence。纯会话衔接类建议允许 `evidenceIds = []`，Mobile 显示“依据当前会话”，不伪装成知识结论。

Evidence 后续被删除或权限改变时，Core 保留生成当时的审计快照。Mobile 不得因 Evidence 变化擅自删除已采用的人工草稿。

## 状态流

```text
当前 owner 主动生成
    ↓
Suggestion READY
    ├─ 会话 revision 不变 → 采用 → Human Draft
    └─ 会话 revision 改变 → STALE → 只能重新生成

Human Draft
    ├─ 客服编辑 → origin = ai_suggestion, edited = true
    ├─ 会话 revision 改变 → 阅读最新消息 → 明确确认 → 可继续使用
    └─ 客服手动发送 → Core 校验 conversationRevision
```

Suggestion stale 后不得自动重新生成，避免新消息到达时在后台持续消耗检索和模型资源。

## UI

默认只使用业务语言，不强调 AI 品牌：

```text
建议回复

方便确认一下设备当前的电源指示灯状态吗？

采用                         依据 3
```

无知识 Evidence 时：

```text
采用                 依据当前会话
```

过期时只显示：

```text
会话有新内容

重新生成
```

不得显示“采用”或继续展示旧依据作为当前结论。

Composer 的 `＋` 菜单只保留：

```text
建议回复
转交处理
联系人资料
```

## 离线与错误

- 离线时禁止生成 Suggestion，但当前 owner 可继续编辑已有 Human Draft。
- Suggestion 失败只影响建议能力，不隐藏 Transcript、Brief 或 Composer。
- 如果 Core 未发布 `structuredSuggestion` capability，Mobile 隐藏“建议回复”入口，不使用旧状态伪造兼容行为。
