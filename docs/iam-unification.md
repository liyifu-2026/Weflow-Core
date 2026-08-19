# Weflow 内部人员 IAM 统一登录

> 目标：Console 与所有内部人员应用（含业务 Solution 提供的应用）共享 **Weflow Core IAM**，实现“一次登录，处处免登”。

## 原则

1. 所有内部人员登录统一走 Core IAM。
2. 业务应用不新建员工账号表。
3. 应用只声明需要的角色/权限，角色判断由 Core 返回。
4. 外部客户/通道联系人永远不是 Weflow 登录用户，使用 `contactRef` / Contact Profile。
5. 未来客户侧登录单独建外部身份域，不与员工账号混用。

## 现状

- Core 统一提供 `/api/v1/auth/me`、`/api/v1/auth/login`、`/api/v1/auth/logout`。
- Console 已使用这套接口。
- 当前重复登录的原因通常是：**登录 Cookie 没有在多个应用之间共享**，而不是存在两套用户系统。

## 已落地

### 1. Core 支持共享 Cookie Domain

文件：`core/modules/identity/interface/request-authentication.ts`

支持环境变量：

```bash
SESSION_COOKIE_DOMAIN=.example.com
```

设置后，Core 种下的会话 Cookie 会带：

```text
Set-Cookie: weflow_session=...; Path=/; HttpOnly; Domain=.example.com; SameSite=Strict; ...
```

这样：

- `console.example.com`
- `api.example.com`

以及未来接入的其他内部应用（同一域下），可以共享同一个 Weflow 登录态。

不设置时保持原行为（host-only Cookie，适合同主机不同路径部署）。

## 部署要求（生产）

推荐同一站点不同路径：

```text
https://weflow.example.com/console/   → Console
https://weflow.example.com/api/       → Core API
```

- Core Cookie `Path=/` 默认已满足；
- 不需要设置 `SESSION_COOKIE_DOMAIN`。

如果必须使用不同子域：

```text
https://console.example.com/          → Console
https://api.example.com/              → Core API
```

则必须设置：

```bash
SESSION_COOKIE_DOMAIN=.example.com
```

并保证所有应用都通过同一个 Core API 域（或同一个网关）访问 `/api`。

## 验证方式

1. 在 Console 登录。
2. 打开同一域下的其他内部应用（如业务 Solution 应用）。
3. 应自动进入首页，不再显示登录页。
4. 如果仍显示登录页：
   - 检查浏览器 Application → Cookies；
   - 确认 `weflow_session` 的 Domain / Path；
   - 确认应用请求 `/api/v1/auth/me` 时带上了 Cookie；
   - 确认 SameSite 没有阻止跨站发送。

## 后续（未做）

- [ ] 如果未来跨站（不同注册域名），再引入 OIDC / OAuth2 统一 SSO。
- [ ] 客户自助门户使用独立外部身份域。
