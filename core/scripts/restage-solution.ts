/**
 * 用平台 staging 工具重建 store 中指定 Solution 版本：
 * 复制（过滤 node_modules 等）+ esbuild 打包 plugin.js，与
 * installSolutionToStore 的 verbatim/staged 分支产出一致。
 *
 * 用法：node --env-file=core/.env node_modules/tsx/dist/cli.mjs scripts/restage-solution.ts <solution-src-dir> <store-version-dir>
 * （在 weflow/core 下运行，走 core 的 tsx + esbuild 依赖）
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { stagePackagedSolution } from "../infrastructure/solutions/solution-stage.js";

const [srcArg, destArg] = process.argv.slice(2);
if (!srcArg || !destArg) {
  console.error(
    "usage: tsx scripts/restage-solution.ts <solution-src> <store-version-dir>",
  );
  process.exit(1);
}
const src = resolve(srcArg);
const dest = resolve(destArg);
if (!existsSync(join(src, "solution.manifest.json"))) {
  console.error(`manifest missing: ${src}`);
  process.exit(1);
}
console.log(`staging ${src} -> ${dest}`);
const staged = await stagePackagedSolution(src);
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(staged, dest, { recursive: true });
rmSync(staged, { recursive: true, force: true });
console.log("staged files:", existsSync(join(dest, "solution.manifest.json")));
console.log(
  "plugin.js:",
  existsSync(
    join(
      dest,
      "plugins",
      "customer-support-strategy",
      "dist",
      "plugin.js",
    ),
  ),
);
process.exit(0);
