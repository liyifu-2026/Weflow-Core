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
);
