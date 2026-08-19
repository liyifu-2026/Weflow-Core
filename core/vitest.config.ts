/**
 * Vitest 配置
 *
 * - 全局 setup 守卫：集成测试只允许连接库名含 "test" 的专用数据库
 * - 默认不启用并行文件执行（package.json 的 test script 已有 --no-file-parallelism）
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
