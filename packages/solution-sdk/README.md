# @weflow/solution-sdk

npm 风格 Solution 包契约的单一实现来源（manifest / lock / signature 三件套）。
Core 的 Store、Registry、Runner 与 `weflowctl` 都通过本包校验和描述 Solution 包。

## 安装形态

一个可安装的 Solution 包是自包含目录（或其 `.tgz`）：

```
solution.manifest.json   # 清单（JSON，YAML 子集）
solution.lock.json       # 解析后的 artifact 摘要（不可变边界）
signature.json           # 对 manifestDigest:lockDigest 的 ed25519 签名
plugins/<id>/dist/plugin.js
```

## API

### Node 入口（`@weflow/solution-sdk`）

- `solutionManifestSchema` / `solutionLockSchema` / `solutionSignatureSchema`
  以及全部派生类型（`SolutionManifestV1`、`SolutionLockV1`、
  `SolutionPackageDescriptor` 等）。
- `parseSolutionManifest(input)` / `parseSolutionLock(input)`：严格解析，失败抛出
  Zod 错误。
- `validateSolutionManifest(input)` / `validateSolutionLock(input)`：非抛出校验，
  返回 `{ ok, value } | { ok: false, issues }`。
- `normalizeSolutionManifest(manifest)`：字段排序后的规范形（digest 输入）。
- `canonicalJson(value)` / `sha256Digest(value)`：键排序的规范化 JSON 与
  `sha256:` 摘要。
- `describeSolution(input)`：解析 manifest 并计算 `manifestDigest`。
- `describeSolutionPackage({ manifest, lock, signature })`：把三件套作为一个
  不可变包边界整体校验（id/version/digest 一致性 + artifact 覆盖完整）。
- `verifySolutionSignature(descriptor, signature, publicKey)`：验证对
  `` `${manifestDigest}:${lockDigest}` `` payload 的 ed25519 签名。

### 浏览器入口（`@weflow/solution-sdk/browser`）

只含纯 schema 校验与 Web Crypto 摘要：

- `validateSolutionManifest` / `validateSolutionLock` / `parse*` / 类型
- `solutionPayloadDigestBrowser(manifest, lock)`：异步计算 `{ manifest, lock }`
  规范化 JSON 的 `sha256:` 摘要。

## 约定

- manifest 仅接受 JSON（YAML 的严格子集）；不做宽松 YAML 解析。
- lock 是发布后不可变的 artifact 摘要清单；任何不一致都应视为损坏的包。
- 签名密钥不进入日志；`signature.json` 只携带 keyId 与签名值。
