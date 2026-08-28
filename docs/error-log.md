# 错题本：调试经验与根因归档

记录真实故障的根因、修复过程和预防措施，避免同类问题反复出现。

---

## 2026-08-26：create-user 密码哈希与密码不匹配 → Console 全页面 401

### 症状

- Console 所有 API 返回"请求未能完成"
- `POST /api/v1/auth/login` 返回 `401 {"error":"invalid_credentials"}`
- 数据库中 users 表有 admin / consoleadmin / verifyop 三个用户
- 所有用户状态为 `active`，哈希格式为合法的 `$argon2id$v=19$m=19456,p=1,t=2$...`

### 根因

**create-user 脚本生成的随机密码未被正确记录，导致密码与哈希不匹配。**

详细分析：

1. `create-user` 脚本调用 `generateInitialPassword()` 生成 `${randomBytes(15).toString("base64url")}!aA1` 格式的随机密码
2. 密码通过 `hashPassword()` 哈希后存入 DB
3. 脚本通过 `process.stdout.write` 打印密码**仅一次**
4. 密码未被保存到任何持久化位置（文件、环境变量、密码管理器）
5. 用户记录的密码（如 `nIFJuSyvVXd8wlXgLd2S!aA1`）与实际哈希不匹配
6. `argon2.verify(storedHash, recordedPassword)` 返回 `false`

验证方法（本次排查中使用）：
```bash
# 直接验证密码是否匹配哈希
node -e "
const argon2 = require('argon2');
const { Client } = require('pg');
async function main() {
  const c = new Client({ connectionString: 'postgresql://weflow:weflow@127.0.0.1:5432/weflow' });
  await c.connect();
  const r = await c.query('SELECT username, password_hash FROM identity.users');
  for (const u of r.rows) {
    for (const pw of ['admin', 'admin123', 'password']) {
      if (await argon2.verify(u.password_hash, pw)) console.log(u.username, ':', pw);
    }
  }
  await c.end();
}
main();
"
```

修复方式（推荐）：
```bash
# 使用 reset-password 脚本（会自动验证哈希匹配）
DATABASE_URL=postgresql://weflow:weflow@127.0.0.1:5432/weflow \
REDIS_URL=redis://127.0.0.1:6379 \
SESSION_SECRET=dev-secret-key \
pnpm reset-password admin --password=NewPassword123
```

修复方式（手动）：
```bash
node -e "
const argon2 = require('argon2');
const { Client } = require('pg');
async function main() {
  const hash = await argon2.hash('admin123', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const c = new Client({ connectionString: 'postgresql://weflow:weflow@127.0.0.1:5432/weflow' });
  await c.connect();
  await c.query('UPDATE identity.users SET password_hash = \$1 WHERE username = \$2', [hash, 'admin']);
  await c.end();
}
main();
"
```

### 为什么没能提前发现

1. **create-user 脚本没有验证步骤**：生成密码 → 哈希 → 写入 DB → 打印密码，但不回头用打印的密码验证哈希
2. **没有登录端到端测试**：数据库迁移后没有自动验证登录流程
3. **密码只显示一次**：没有持久化记录，出问题后无法回溯

### 预防措施

1. **create-user 脚本加验证**：哈希完成后，立即用明文密码验证一次，确认匹配后再输出
2. **添加 reset-password CLI**：`pnpm reset-password <username>` 允许重新设置密码（见下方实现）
3. **添加 smoke test**：数据库迁移后自动运行登录验证

---

## 2026-08-26：缺失 dashboard/cards 和 solutions/health 路由 → Console 页面 404

### 症状

- 平台总览页"暂无业务信息"
- 系统状态页部分数据加载失败
- API 返回 `404 {"message":"Route GET:/api/v1/admin/dashboard/cards not found"}`

### 根因

**Console 前端调用了后端未实现的 API 端点。**

- `OverviewV2.vue` 调用 `/api/v1/admin/dashboard/cards`
- `SystemStatusView.vue` 调用 `/api/v1/admin/solutions/health`
- 这两个路由在 `http-routes.ts` 中未注册

### 修复

在 `http-routes.ts` 中添加两个路由，返回空数据结构：
```typescript
server.get("/api/v1/admin/dashboard/cards", async (request, reply) => {
  if (!(await requireAdminIdentity(db, request, reply))) return;
  return { cards: [] };
});

server.get("/api/v1/admin/solutions/health", async (request, reply) => {
  if (!(await requireAdminIdentity(db, request, reply))) return;
  return { solutions: [] };
});
```

### 预防措施

1. **前后端契约检查**：新增 Console 页面时，同步确认对应后端路由存在
2. **API 契约测试**：收集前端所有 `api<>()` 调用路径，与后端路由表做差集检查

---

## 通用经验

### tsx watch 不自动重启

- 现象：修改代码后 `tsx watch` 没有自动重启子进程
- 原因：子进程崩溃后 tsx watch 不会重新 spawn（尤其是缺少环境变量时）
- 解决：检查 `.data/logs/core.err.log` 确认启动错误，手动重启时需加载完整 `.env`
- 预防：用 `scripts/start-dev.ps1` 启动，它会自动 `Load-Env`

### argon2 密码哈希验证

- argon2.verify 会从哈希字符串中读取参数（m/p/t），不需要传入参数
- 如果 verify 返回 false，说明密码本身不匹配，不是参数问题
- 快速验证方法：`argon2.verify(storedHash, candidatePassword)` → boolean
