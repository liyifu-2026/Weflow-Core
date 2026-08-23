# Weflow Solutions 仓库守则

本仓库（`weflow-solutions`）是**业务 Solution 的唯一来源**。平台核心仓库（`weflow`，即 Weflow-Core）不包含业务代码；业务 UI、业务 Agent 插件、业务后端都从这里开发、构建、发布，再安装到任意 Weflow 平台实例。

## 职责边界

- **`weflow-solutions`（业务层）**：具体业务逻辑、业务 UI、业务策略、业务技能、业务 BFF。
- **`weflow` / `apps/console`（平台层）**：认证、会话/消息/Handoff 等领域事实、系统管理、ExtensionHost、审计、设置等平台级能力。
- Console 只负责用 `ExtensionHost` 承载业务 UI；业务页面本体必须在本仓库，不能写进 `weflow/apps/console`。

## 仓库布局约定

```text
solutions/
└─ <solution>/
   ├─ solution.manifest.json   # 声明 consoleExtensions、plugins、backend、applications 等
   ├─ apps/<app>               # 业务 UI 应用（如 support-web）
   ├─ plugins/                 # 业务 Agent 插件（Skill / Execution Strategy）
   └─ backend/                 # 业务 BFF / 后端
```

## 绝对禁止

- 禁止把业务 UI、业务页面、业务路由、业务文案、业务组件实现到 `weflow/apps/console`。
  - 例如：客服工作台、会话 / Handoff 业务页面、微信 / 具体通道相关 UI、任何只属于某个 Solution 的页面。
- 禁止在 Core 中硬编码业务策略、业务 Prompt、业务状态机。
- 禁止把本仓库已下沉的业务功能反向搬回 `weflow`（含 `apps/console`、`core`）。
- 禁止在本仓库放置平台壳代码（如 Console 本体、Core 内部模块）；本仓库只放业务 Solution。

## 正确开发路径

- 业务 UI：
  - 源码放 `solutions/<solution>/apps/<app>`（例如 `solutions/customer-support/apps/support-web`）。
  - 在 `solutions/<solution>/solution.manifest.json` 的 `consoleExtensions` 声明入口和导航。
  - 通过 Console 的 `ExtensionHost` 加载；不在 Console 里新增业务页面。
- 业务 Agent 能力：放 `solutions/<solution>/plugins`（Skill、Execution Strategy 等）。
- 业务后端：放 `solutions/<solution>/backend`。
- 平台壳需要改动时：去 `weflow/apps/console` 改，且必须是平台级、业务中立的改动（如 ExtensionHost 增强、通用导航/设置/审计/系统状态）。

## consoleExtensions 契约

- 业务 UI 要出现在 Console 中，必须在 `solution.manifest.json` 中声明 `consoleExtensions`，包含 `id`、`title`、`entry`、`nav` 等字段。
- `entry` 可以是远程地址或 Console 可加载的远程模块；Console 的 `ExtensionHost` 只负责承载，不实现业务页面。
- 示例（`solutions/customer-support/solution.manifest.json`）：

```json
{
  "id": "support-console",
  "title": "客服工作台",
  "entry": "http://localhost:5174/support/",
  "nav": { "group": "业务", "label": "客服工作台", "icon": "conversations" }
}
```

## 提交前自检清单

- 本次业务 UI 是否放在 `solutions/<solution>/apps/<app>`？
  - 如果没有，说明放错位置。
- 本次业务页面是否在 `solution.manifest.json` 的 `consoleExtensions` 中声明？
  - 如果没有，Console 无法正确挂载。
- 本次业务改动是否误改了 `weflow/apps/console`？
  - 如果业务专属页面/路由/文案/组件出现在 Console，必须撤回并移到本仓库。
- 本次改动是否属于平台壳能力（ExtensionHost、通用设置、审计等）？
  - 如果是，应去 `weflow` 仓库，而不是本仓库。

## 示例

- 正确：
  - `solutions/customer-support/apps/support-web`
  - `solutions/customer-support/solution.manifest.json` 中的 `consoleExtensions`
- 错误：
  - `weflow/apps/console/src/weflow/views/ConversationsView.vue`
  - 在 Console 中直接写“客服工作台 / 会话 / Handoff 业务页面”

## 违规检测方法

- 检查 PR / diff：如果 `weflow/apps/console` 下新增了业务专属标题、路由、组件或文案，立即拦截并确认是否应放入本仓库。
- 检查本仓库业务页面：每个业务 UI 都应在对应 `solution.manifest.json` 的 `consoleExtensions` 中有声明；没有声明就不是合格的 Solution App。
- 检查反向迁移：本仓库已有的业务代码不应出现在 `weflow` 仓库的 diff 中；出现即视为违规。

## 验证

- 改动后运行 `pnpm build` 与 `pnpm verify`，确保 manifest / lock / signature 一致。
- 涉及插件时按 README 的门禁流程验证（快捷注入 + Solution Pack 安装 + e2e gate）。
