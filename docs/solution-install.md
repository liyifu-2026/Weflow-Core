# 业务方案安装指南

Weflow 是平台宿主，业务以 Solution Pack（业务整合包）方式安装。

## 快速安装业务方案

1. 打开 Console：`http://localhost:5173/console/`
2. 左侧菜单：**方案 → 业务方案**
3. 点击 **导入压缩包**
4. 选择方案压缩包，如 `solutions/knowledge/knowledge.zip`
5. 系统自动识别并创建安装 Operation
6. 等待 Runner 执行完成，状态变为 **已安装**
7. 选中方案，点击 **激活**，状态变为 **已激活**

## 压缩包结构

```
solution.zip
├── solution.manifest.json
├── solution.lock.json
├── signature.json
├── artifacts/
│   ├── <plugin-artifact>.tgz
│   └── ...
└── backend/
    └── <solution>/index.js
```

`manifest` 声明的 `executionProfiles` 会在安装/升级成功时自动同步到 `agent.execution_profiles`（status=active，profileId 形如 `<solutionId>/<profileId>`），使 Agent Turn 准入与按 `strategyRef` 精确选择 Execution Strategy 立即可用。

## 后端接口

```
POST /api/v1/admin/solutions/import
Content-Type: multipart/form-data
file: <solution.zip>
```

管理员身份调用；导入后返回创建的 Operation。

## 已提供的业务包

- `solutions/knowledge/knowledge.zip`：知识业务包（官方基础 Solution）
- `solutions/memory/memory.zip`：记忆业务包（官方基础 Solution）
- 客服业务包（`weflow.customer-support`）已迁出为独立仓库 **Weflow-Solutions**（`github.com/liyifu-2026/Weflow-Solutions`），其中提供 `pnpm flow:dev` 一键流水线：构建插件 → 打包 → 校验 → 快捷门禁 → 安装到平台 → 按 Execution Profile 的正式门禁（详见该仓库 README）。

## 环境要求

- Solution Runner 需要运行，并配置：
  - `CORE_API_URL`
  - `RUNNER_TOKEN`
  - `SOLUTION_STAGING_ROOT`
  - 开发环境可设 `SOLUTION_DEV_UNSIGNED=1`

## Console 动态扩展

业务包可以在 `solution.manifest.json` 中声明 `consoleExtensions`，安装激活后会自动出现在 Console 侧栏：

```json
{
  "consoleExtensions": [
    {
      "id": "knowledge-console",
      "title": "知识库",
      "entry": "/knowledge",
      "nav": {
        "group": "业务",
        "label": "知识库",
        "order": 10
      },
      "settings": true
    }
  ]
}
```

- `nav`：动态侧栏项
- `entry`：业务前端地址；`iframe URL` 或远程 ES Module（`.ts` / `.js`，导出 `mount(container)` 或 Vue 组件）
- `settings`：进入 Console「系统设置」中心，作为业务设置入口
- `settingsSchema`：可选，声明设置字段，Console 自动生成表单并统一保存
- `settingsContributions`：可选，声明设置项分类归属；`category` 是分类标识，`categoryLabel` 可选，用于在 Console 显示自定义分类名（缺省时 `general` 显示为「通用」，其他分类显示为分类标识本身）
- `dashboardContributions`：可选，声明总览卡片（标题、布局、刷新间隔）
- `apiRoutes`：可选，声明业务包 API 路由前缀与代理目标
- `eventSubscriptions`：可选，订阅平台事件（如 `conversation.created`、`user.login`）
- `backend.entry`：可选，声明后端插件模块，Core 启动时动态加载并注册路由
