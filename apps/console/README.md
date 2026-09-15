# Weflow Console（已退役，冻结维护）

R1 收敛后 Console 平台壳退役：产品网页端唯一来源是
`solutions/customer-support/apps/support-web`，部署产物由
Core API 静态托管；本应用不再构建、不再发布（`platform-verify` 不构建它，
`deploy/compose.yaml` 不含它，`weflowctl dev` 的 `console` key 实际启动的是
support-web）。

仅保留以下平台级页面，供本地参考；**不再新增功能，不承载任何业务 UI**：

- 登录 / 修改密码 / 帮助 / 个人资料
- 系统用户（`/system/users`）
- 审计日志（`/system/audit`）
- 系统状态（`/system/status`）

新平台级能力一律进 support-web 或 Core API，见根目录 `AGENTS.md` 的边界条款。

## 本地校验（如需）

```bash
corepack pnpm install
corepack pnpm check
```
