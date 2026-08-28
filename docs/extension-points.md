# Weflow Console 扩展点架构

> 目标：让 Console 变成类似 Obsidian 的插件化宿主。
> 业务包安装后，其设置项、总览卡片、导航入口自动融合进 Console 原生界面，
> 而不是另起独立全屏页面或独立 Tab。

## 1. 设计原则

1. **Console 是宿主，不拥有业务**。
2. 业务包通过 `solution.manifest.json` 声明扩展点。
3. 原生设置与插件设置**混合渲染**，可标注来源但不强制区分。
4. 所有业务包设置统一持久化，键名带插件 ID 前缀。
5. 只有管理员（具备“管理设置”权限）可查看/修改设置。
6. 后端提供统一代理与事件钩子，业务包不直接暴露裸端口。

## 2. 扩展点类型

| 扩展点 | 说明 | 现状 |
|---|---|---|
| `nav` | 侧栏导航项 | ✅ 已有 |
| `settings` | 设置项，按分类融合进设置页 | ⚠️ 已有入口，需改为分类插槽 |
| `dashboard` | 总览卡片，栅格布局 | ❌ 未实现 |
| `api` | 业务包 API 路由注册与统一代理 | ❌ 未实现 |
| `events` | 平台事件订阅 | ❌ 未实现 |

## 3. 清单文件扩展

在 `solution.manifest.json` 中新增/规范：

```json
{
  "consoleExtensions": [
    {
      "id": "knowledge-console",
      "title": "知识库",
      "nav": { "group": "业务", "label": "知识库" },
      "settings": {
        "contributions": [
          {
            "id": "provider-config",
            "category": "integrations",
            "label": "知识 Provider 配置",
            "component": "settings/provider-config.ts",
            "order": 10
          },
          {
            "id": "retrieval-enabled",
            "category": "general",
            "label": "启用检索",
            "component": "settings/retrieval-enabled.ts",
            "order": 20
          }
        ]
      },
      "dashboard": {
        "contributions": [
          {
            "id": "today-retrievals",
            "title": "今日检索量",
            "component": "dashboard/today-retrievals.ts",
            "defaultPosition": { "x": 0, "y": 0, "w": 4, "h": 2 },
            "refreshInterval": 30000,
            "api": "/api/dashboard/stats"
          }
        ]
      },
      "api": {
        "routes": [
          { "prefix": "/knowledge", "target": "http://knowledge-solution:8080" }
        ]
      },
      "events": {
        "subscribe": ["user.login", "conversation.created"]
      }
    }
  ]
}
```

> **`entry` 可选**：只有插件确实需要独立 Console 页面时才声明 `entry`（URL 或 JS 模块）。如果插件只提供设置项、Dashboard 卡片或 API，可以**不声明 `entry` 和 `nav`**，Console 不会为它生成导航入口或扩展页面。

### 3.1 settings.contributions

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 设置项唯一 ID |
| `category` | enum | `general` / `integrations` / `security` / `advanced` |
| `label` | string | 设置项显示名 |
| `component` | string | 远程组件入口（ES Module） |
| `order` | number | 同分类内排序权重 |
| `schema` | SettingField[] | 可选，无 component 时由 Console 自动生成表单 |

### 3.2 dashboard.contributions

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 卡片 ID |
| `title` | string | 卡片标题 |
| `component` | string | 卡片渲染组件（ES Module） |
| `defaultPosition` | object | `{x,y,w,h}` 默认布局 |
| `refreshInterval` | number | 可选轮询间隔（ms） |
| `api` | string | 可选数据接口（相对业务包 API 前缀） |

## 4. Console 前端扩展点

### 4.1 设置页（Settings）

- 分类固定为：`general`（通用）、`integrations`（集成）、`security`（安全）、`advanced`（高级）。
- 每个分类是一个插槽（slot）。
- Console 从已安装方案聚合所有 `settings.contributions`，按 `category + order` 排序。
- 每个设置项渲染：
  - 有 `component`：动态加载远程组件（`mount(container)` 或 Vue 组件）。
  - 有 `schema`：Console 自动生成表单，调用系统设置 API 保存。
- 切换分类只重新渲染该分类插槽，不刷新整页。

### 4.2 总览 Dashboard

- 总览页根据已安装方案聚合所有 `dashboard.contributions`。
- 使用栅格布局（参考 react-grid-layout / vue-grid-layout），支持拖拽与缩放。
- 卡片数据来源：
  - 优先由后端聚合接口 `/api/v1/admin/dashboard/cards` 返回。
  - 或由卡片组件直接调用业务包 API。
- 卡片状态：loading / error / empty / ready。
- 布局偏好保存到用户配置。

### 4.3 导航

- 已实现，继续沿用 `nav`。

## 5. 后端扩展点

### 5.1 插件注册中心

- 安装/激活方案时，解析 `consoleExtensions` 并写入注册表。
- 提供查询接口：

```
GET /api/v1/admin/extensions
GET /api/v1/admin/solutions/:solutionId/extensions
```

### 5.2 系统设置存储

- 表：`solution.extension_settings`（已建）。
- 键名规范：`{pluginId}.{contributionId}`，避免冲突。
- API：

```
GET  /api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings
PUT  /api/v1/admin/solutions/:solutionId/extensions/:extensionId/settings
```

### 5.3 Dashboard 数据聚合

```
GET /api/v1/admin/dashboard/cards
```

返回：

```json
{
  "cards": [
    {
      "id": "knowledge.today-retrievals",
      "title": "今日检索量",
      "position": { "x": 0, "y": 0, "w": 4, "h": 2 },
      "data": { "count": 128 },
      "status": "ready",
      "error": null
    }
  ]
}
```

后端调用每个业务包声明的 `api` 地址，统一聚合，减少前端并发请求。

### 5.4 API 统一代理

- 业务包安装时注册 `api.routes` 前缀。
- Console/前端通过统一入口调用：

```
/api/v1/plugins/{pluginId}/...
```

- 后端负责鉴权、审计、超时与错误标准化。

### 5.5 事件钩子

- 业务包可订阅平台事件。
- 事件总线实现后，`conversation.created`、`user.login` 等事件会推送给订阅业务包。

## 6. 组件约定

远程组件模块需导出以下之一：

```ts
// 方式一：Vue 组件
export default { render() { ... } }

// 方式二：mount 函数
export function mount(container: HTMLElement) { ... }
```

建议业务包使用 `mount(container)` 以降低耦合。

## 7. 权限

- 只有 `admin` 角色可访问设置中心与总览卡片管理。
- 后端在设置 API、dashboard API、插件代理 API 上强制 `requireAdminIdentity`。
- 后续可细化到 `manage_settings` 权限点。

## 7.5 后端插件运行时

业务包可在 manifest 中声明：

```json
{
  "backend": {
    "entry": "backend/index.js"
  }
}
```

该模块需导出：

```js
export async function registerRoutes(server, ctx) {
  // ctx.db / ctx.schema / ctx.count / ctx.eq / ctx.gte / ctx.inArray / ctx.logger
}
```

客服业务包 `weflow.customer-support` 已提供 `/customer-support/status`、`/customer-support/handoffs`、人工交接 accept/take-over/transfer/resolve 等接口。

知识业务包 `weflow.knowledge` 已提供 `/knowledge/status`、`/knowledge/retrievals`（GET/POST）、`/knowledge/threads`（GET/POST）、`/knowledge/bases`、`/knowledge/search`。

记忆业务包 `weflow.memory` 已提供 `/memory/status`、`/memory/memories`（GET/POST）、`/memory/capture-states`。

Dashboard 聚合已泛化：业务包只要声明 `dashboard.contributions[].api` 和 `apiRoutes`，Core 会自动调用业务包接口并聚合到总览卡片。客服/知识/记忆卡片均已生效。

注意：多业务包共存时，`backend.entry` 必须使用唯一路径（如 `backend/knowledge/index.js`、`backend/memory/index.js`），避免覆盖同一 staging 文件。

## 8. 迁移策略

### 阶段 1：稳定插件机制（当前）

- 保留现有独立设置入口，但后端已具备 settings 存储与扩展查询。
- 将现有 `SettingsCenter` 改造成“分类插槽 + 动态组件”结构。
- 业务包改为声明 `settings.contributions` 与 `dashboard.contributions`。

### 阶段 2：迁移核心业务

- 将知识、记忆等业务从 Core 抽离为业务包。
- Console 移除硬编码业务路由，只保留平台管理 + 动态扩展。

### 阶段 3：清理旧代码

- 删除旧知识页面与旧路由。
- 数据迁移：旧 settings 键名按插件 ID 重命名。

## 9. 推荐实施顺序

1. 编写本规范（✅ 本文档）
2. 改造 SettingsCenter：分类插槽 + 动态组件
3. 实现 dashboard 卡片注册与栅格布局
4. 后端 dashboard 聚合接口
5. 业务包 API 统一代理
6. 事件总线
7. 业务包迁移（知识、记忆等）
