/**
 * ESLint 配置文件
 *
 * 用途：配置代码检查规则，使用 TypeScript-ESLint 的严格类型检查预设
 * - 忽略构建产物和依赖目录
 * - 启用 TypeScript 项目服务进行类型感知 lint
 * - 强制使用一致的类型导入语法
 */
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // 忽略构建产物、依赖和缓存目录
  {
    ignores: [
      ".corepack/**",
      ".npm-cache/**",
      ".pnpm-store/**",
      ".data/**",
      "dist/**",
      ".dist.previous/**",
      ".dist-root-owned-backup/**",
      "node_modules/**",
      "coverage/**",
      "eslint.config.js",
    ],
  },
  eslint.configs.recommended, // ESLint 推荐规则
  ...tseslint.configs.strictTypeChecked, // TypeScript 严格类型检查规则
  // TypeScript 文件特定配置
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true, // 启用 TypeScript 项目服务
        tsconfigRootDir: import.meta.dirname, // 项目根目录
      },
    },
    rules: {
      // 强制使用 `import type` 语法导入纯类型
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  // TS 之外的文件（scripts/*.mjs、*.mts 等）不在 tsconfig 项目内，拿不到类型
  // 信息；对它们关闭类型感知规则，否则 strictTypeChecked 的 typed 规则会让
  // eslint 直接崩溃。
  {
    files: ["**/*"],
    ignores: ["**/*.ts", "**/*.tsx"],
    ...tseslint.configs.disableTypeChecked,
  },
  // 测试代码不做类型感知强约束：非空断言、宽松 any 是测试惯用法，
  // 类型感知规则的增量收紧先在生产代码（apps/ modules/ infrastructure/）完成。
  {
    files: ["tests/**", "**/*.test.ts"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // 测试惯用法：直接断言非空 / 用 any 造桩都在测试里是合理的
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // TS 自己做标识符解析，no-undef 对 TS 无效且误报 Node/测试全局
      "no-undef": "off",
    },
  },
  // 运维/演示脚本同样放宽（与 tests 同理；脚本允许快速胶水代码）。
  {
    files: ["scripts/**"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": "off",
    },
  },
);
