# Customer Support Solution

首个官方 Weflow Solution Pack。

## 组成

- Execution Strategy：`weflow.customer-support/structured-v1`
- Skill：`weflow.customer-support/product-troubleshooting`
- App：Support Web
- App：Mobile
- 可选 BFF：Support BFF

## 当前状态

- Manifest / Lock / Signature 已建立并通过校验
- 领域类型已下沉到 `@weflow/contracts`
- ProductTroubleshootingSkill 真实实现已迁入插件（自包含）
- Customer Support System Prompt 已迁入 strategy 插件
- 模型响应解析器已迁入 strategy 插件（AgentAction 映射）
- `platform-default` 生产 seed 已移除；测试库由 `tests/setup.ts` 注入 test profile
- `file:` artifact 已具备真实 digest 校验
- 签名使用 `keys/dev-private.pem` 生成，`keys/dev-public.pem` 用于验证

## 目录

```text
solutions/customer-support/
├─ solution.manifest.json
├─ solution.lock.json
├─ signature.json
├─ artifacts/
│  ├─ customer-support-strategy.tgz
│  ├─ product-troubleshooting.tgz
│  ├─ support-web.tgz
│  ├─ support-schema.sql
│  └─ mobile.tgz
├─ keys/
│  ├─ dev-private.pem
│  └─ dev-public.pem
├─ plugins/
│  ├─ customer-support-strategy/
│  └─ product-troubleshooting/
└─ README.md
```

## 验证

```bash
pnpm solution:verify
pnpm release:verify
```

## 发布门禁

- Firebase 包名属于 Customer Support Solution 发布门禁，不作为纯 Platform 发布阻断。
- 真实微信设备与外部 Provider 验收也属于本 Solution 的发布门禁。
