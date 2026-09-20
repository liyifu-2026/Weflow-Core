# ADR-0014: 业务子树迁移搭乘引擎迁移列车（决策保留）

日期：2026-09-20
状态：已接受

## 背景

`core/migrations/0061_customer_support_ai_employees.sql` 在引擎迁移列车里
创建了 `customer_support` PG schema（业务 AI 员工表）。架构评审（2026-09-20
第 2 轮）指出：引擎的发布产物携带并应用业务 schema，擦边界。

核实事实：该 schema 在引擎代码中零引用（`core/modules/`、`infrastructure/`、
`apps/` 无一读写），文件头有明确说明，业务子树通过插件 SDK 使用自己的连接
访问它。

## 决策

**保留现状，不拆分迁移列车；以本 ADR 记录耦合决策。**

理由：

1. 单进程、单库产品（CONTEXT.md）：业务子树与引擎同库部署，拆分列车会
   迫使部署方维护两条迁移管线，运维成本大于边界收益。
2. 迁移文件物理隔离、命名显式（`customer_support` 前缀自说明）、引擎代码
   零依赖——边界擦除只发生在"谁执行 DDL"这一层，不产生代码耦合。
3. 若未来出现第二个业务子树或独立部署业务库的需求，再拆分为由同一
   migrate 工具执行的第二条 journal（届时废弃本 ADR）。

## 后果

- 引擎镜像/发布物包含业务 schema DDL，属于已知且接受的耦合。
- 新业务表的迁移文件必须继续放在业务前缀命名之下，且引擎代码不得引用。
- 迁移文件与 journal 的一致性由 `scripts/check-migration-journal.ts` 把关。
