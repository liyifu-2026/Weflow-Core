import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const root = fileURLToPath(new URL("../src/weflow/", import.meta.url));
// knowledge/api.ts is the ONLY Weflow adapter allowed to touch the legacy
// compatibility layer; all Knowledge UI must go through it.
const allowed = new Set(["legacy-knowledge/provider.ts", "knowledge/api.ts"]);

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/**
 * 解析文件中的 import/require 目标路径（静态与动态 import 字面量）。
 * 返回模块说明符数组；模板串等非字面量忽略。
 */
function importSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:from\s+|import\s*\()\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/**
 * 解析说明符是否落到 src/ 下的非 weflow 目录（即遗留层）。
 * 覆盖 `@/...` 别名、相对路径与裸包名（裸包名一律放行，由依赖声明约束）。
 */
function resolvesIntoLegacy(specifier, filePath) {
  let target;
  if (specifier.startsWith("@/")) {
    // tsconfig/vite 均把 `@/` 映射到 src/（不是项目根）
    target = resolve(dirname(root), specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    target = resolve(dirname(filePath), specifier);
  } else {
    return false; // 裸包名（npm 依赖）
  }
  // 忽略扩展名差异，比较路径前缀
  const srcRoot = resolve(root, "..");
  if (!target.startsWith(srcRoot)) return false;
  return !target.startsWith(root);
}

const violations = files(root)
  .filter((path) => /\.(?:ts|vue)$/.test(path))
  .filter((path) => !allowed.has(relative(root, path)))
  .filter((path) => {
    const source = readFileSync(path, "utf8");
    return importSpecifiers(source).some((specifier) =>
      resolvesIntoLegacy(specifier, path),
    );
  });

if (violations.length) {
  throw new Error(
    `Native Weflow pages reference the legacy layer outside the whitelisted adapter:\n${violations.join("\n")}`,
  );
}
