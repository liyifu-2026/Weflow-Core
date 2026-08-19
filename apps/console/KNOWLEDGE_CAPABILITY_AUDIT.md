# Weflow Knowledge — Capability Audit

> 基于 2026-08-11 运行时实测（非旧文档猜测）。
> 部署：WeKnora v0.7.1（2026-07-30 构建）+ Server2（knowledge-provider 白名单代理）。
> 技术真相仅存于本文档与代码注释；用户 UI 使用产品语言（如「尚未启用」）。

## 部署配置修复（本轮完成，写路径打通的前提）

| 项 | 变更 |
| --- | --- |
| 上游 API key（tenant_api_keys id=1「工具」） | `full_access: false → true`，capabilities 扩展为 `["retrieve","chat","knowledge_manage","datasource","wiki","faq"]`（原仅 retrieve/chat → 写操作全部 403） |
| E2E 结论 | 新建 KB 必须绑定 `embedding_model_id`，否则解析任务卡在 processing（`model ID cannot be empty`） |

## Capability Matrix

| WeKnora Capability | Upstream Support | Server2 Proxy Support | Weflow UI Support | Missing Contract | Migration Priority |
| --- | --- | --- | --- | --- | --- |
| 知识库 CRUD / 复制 / 置顶 | v0.7.1 ✓ | `knowledge-bases/*` 全放行（实测 200/201） | 内容模式：选择/新建/编辑/复制/删除/活动 ✓ | — | 已完成 |
| 文档列表 / 筛选 / 解析状态 | ✓ | `knowledge-bases/{id}/knowledge` 实测 200 | 内容模式：列表/关键词/类型/状态筛选/轮询 ✓ | — | 已完成 |
| 文件 / URL / 在线文本导入 | ✓ | `knowledge/file`、`/url`、`/manual` 实测 201 | 上传弹窗（三来源）✓ | — | 已完成 |
| Per-upload 高级覆盖（parser/chunking/parent-child/问题生成/Graph） | ✓ | `process_config` 透传实测生效 | 上传弹窗「高级设置」折叠区 ✓ | — | 已完成 |
| 重新解析 / 停止解析 / 删除 / 移动 / 批量 | ✓ | `reparse`/`cancel-parse`/`batch-*`/`move` 实测 | 行菜单 + 批量条 ✓ | — | 已完成 |
| Chunk 列表 / 编辑 / 启停（乐观锁） | ✓ | `chunks/*` 实测（含 409 冲突） | 预览抽屉 Chunk tab ✓ | — | 已完成 |
| Chunk 版本历史 / 回滚 | ✓ | `chunks/{id}/{cid}/revisions`、`/revert` 实测 | 版本历史抽屉 ✓ | — | 已完成 |
| Chunk 问题生成 | ✓ | `chunks/by-id/{id}/questions*` 实测 | Chunk 编辑区「添加/重新生成」✓ | — | 已完成 |
| Parent-child chunk 上下文 | ✓ | `chunks/by-id/{id}` 实测 | Chunk 行 parent 标记（完整上下文浮层后续） | — | 中（增强） |
| 证据检索（knowledge-search） | ✓ | `knowledge-search` POST 实测 200 | 验证模式 ✓（normalizer 隔离） | — | 已完成 |
| 标签体系（KB/文档/批量） | ✓ | `knowledge-bases/{id}/tags`、`knowledge/tags` 实测 | 标签管理抽屉 + 上传标签选择 ✓（批量打标 UI 后续） | — | 中（批量 UI） |
| FAQ 管理（CRUD/启停/搜索） | ✓（仅 FAQ 型 KB） | `knowledge-bases/{id}/faq/*` 实测 | FAQ 视图 ✓ | — | 已完成 |
| FAQ 导入 / 导出 | ✓ | `faq/entries/export`、导入进度 | 未接 UI | 导入导出入口（API 可用） | 中 |
| Wiki 页面 / 编辑 / 删除（乐观锁） | ✓ | `knowledgebase/{id}/wiki/*` 实测 | Wiki 视图（极简渲染）✓ | — | 已完成 |
| Wiki 层级 / 文件夹树 | ✓ | `wiki/folders` 代理放行 | 未接 UI | — | 中 |
| Wiki Graph / 版本 diff / issues | ✓ | `wiki/graph`、`revisions` 代理放行 | 未接 UI | — | 低（重建成本高） |
| 数据源（Feishu/Notion/Yuque/RSS） | ✓ | `datasource/*` 代理放行（key scope 修复后可用） | 数据源模式入口（状态「尚未启用」→ 本轮 key 修复后实际可用，待 UI 落地） | 同步日志/计划 UI | 中 |
| 检索配置（dense/BM25/rerank/threshold） | ✓（tenants/kv） | 未代理 | 配置模式「尚未启用」 | **Server Contract Needed**：`/api/v1/tenants/kv/retrieval-config` | 高 |
| 模型 / Vector Store / Storage 配置 | ✓ | `models`/`vector-stores`/`storage-backends` 代理放行（key 修复后可用） | 配置模式「尚未启用」 | 配置 UI（API 已通） | 中 |
| Parser 引擎注册表 | ✓（system） | 未代理 | 配置模式「尚未启用」 | **Server Contract Needed**：parser engine registry | 低 |
| 分块预览调试 | ✓ | `chunker/preview` 实测 | 未接 UI | — | 低 |
| 处理 trace（spans） | ✓ | `knowledge/{id}/spans` 代理放行 | 未接 UI（API 已封装） | — | 中 |
| 文档摘要 / 重新生成 | ✓ | `regenerate-summary` 代理放行 | 未接 UI（API 已封装） | — | 中 |
| KB 活动记录 | ✓ | `knowledge-bases/{id}/activity` 代理放行 | 活动记录抽屉 ✓ | — | 已完成 |
| 全局知识搜索（跨 KB） | ✓ | 原生 `/api/v1/knowledge/scopes` + 代理 search | 验证模式（自动全库范围）✓ | — | 已完成 |

## 架构边界（已落地）

```
WeKnora / legacy provider
        ↓ src/weflow/knowledge/api.ts（唯一接触点，边界脚本强制）
        ↓ evidence-normalizer.ts + capability-registry.ts
        ↓ Knowledge UI（验证 | 内容 | 数据源 | 配置）
```

- `scripts/check-knowledge-boundary.mjs`：白名单仅 `knowledge/api.ts`（+ 回退视图）
- `capability-registry.ts`：availability（能不能用）与 health（现在是否正常）双维度分离
- `evidence-normalizer.ts`：`WeflowEvidence` 固定类型，上游升级只改 normalizer

## 最高约束

> Do not simplify by deleting capability. Simplify by delaying visibility until the capability becomes relevant.
