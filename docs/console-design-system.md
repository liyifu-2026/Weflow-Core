# Weflow Console 设计系统 v2（进行中）

> 本文件是"推倒重来"方向的设计契约。实现以 `apps/console/src/assets/weflow-console.css`
> 中的 CSS 自定义属性为准；业务 Solution 前端通过宿主 token 继承同一主题。

## 设计定位

Weflow Console 是**运营指挥面（Control Room）**：安静、克制、精确、可信。
避免装饰性卡片与"AI 味"模板；用排版层级、语义状态与留白建立秩序。

## 核心原则

1. 语义 token，组件内禁裸色。
2. 4px 间距网格；圆角三档（control 9 / popover 14 / dialog 16）。
3. 动效有名字：fast 140ms / medium 220ms / slow 320ms；ease-out 为主，抽屉可用 spring。
4. 深浅主题一等公民：任何新样式必须同时覆盖 `[data-theme="dark"]`。
5. 图标唯一来源 `WfIcon.vue`；禁止文字符号（× ✕ ← ··· ⠿）当图标。
6. 每页五态齐全：loading / empty / error / success / transition。
7. 状态文案唯一来源 `@weflow/ui` labels / status-tone。

## Token 契约（宿主：Console）

| 分组 | 变量 |
|---|---|
| 表面 | `--wf-bg --wf-surface --wf-surface-elevated --wf-surface-soft --wf-surface-inset --wf-surface-hover` |
| 文本 | `--wf-text --wf-text-secondary --wf-text-muted` |
| 边框 | `--wf-border --wf-border-strong` |
| 品牌 | `--wf-primary --wf-primary-hover --wf-primary-soft --wf-on-primary` |
| 语义 | `--wf-danger --wf-danger-soft --wf-warning --wf-warning-soft --wf-focus` |
| 导航轨 | `--wf-rail-bg --wf-rail-text --wf-rail-text-strong --wf-rail-hover --wf-rail-active --wf-rail-active-text --wf-rail-border` |
| 阴影 | `--wf-shadow-1 --wf-shadow-2 --wf-shadow-overlay --wf-overlay` |
| 动效 | `--wf-motion-fast --wf-motion-medium --wf-motion-slow --wf-ease-out --wf-ease-spring` |
| 文字 | `--wf-type-display/28 --wf-type-title/22 --wf-type-section/15 --wf-type-body/14 --wf-type-secondary/13 --wf-type-meta/12` |

## 业务扩展契约（weflow-solutions 侧）

- Console 在 `:root` 提供全部 `--wf-*`；业务模块注入的样式**不得重定义 `:root`
  或任何 `.wf-*` 基类**（历史污染已由 `support-web/src/host.css` 适配层修复）。
- 业务组件内部使用语义别名（如 `--primary: var(--wf-primary, fallback)`），
  独立 dev 模式由完整 `style.css` 提供 fallback，托管模式自动继承宿主深浅主题。

## 视觉 QA 门禁

- 每个阶段生成截图矩阵：页面 × 浅色/深色 × 1024/1440。
- 程序化检查：`overflowX === 0`、关键 token 计算值、页面核心元素存在性。
- 人工目检：对齐、间距、对比度、层级、动效。

## 当前实施状态（v2 进行中）

- 已落地：暗色导航轨 Shell、登录/改密品牌样板、Overview 控制室首屏、
  SystemStatus 分组循环、SettingsCenter 信息架构收敛、Operations 面板化、
  Users/Audit/Solutions 工具条与向导、共享 StatusStrip / PageHeader(eyebrow) /
  EmptyState / focus-trap、WfIcon 图标统一。
- CSS 清理：`weflow-console.css` 86KB → 40KB（删除 334 个死规则块 + 38 个混合选择器分支）。
- 待验证：用户执行两侧 `pnpm build` 后，完成 support-web 托管模式
  （`host.css` 适配层）的深色继承与零污染复验。

