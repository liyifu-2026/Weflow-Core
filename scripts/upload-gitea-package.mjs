#!/usr/bin/env node
/**
 * 上传 Weflow 桌面端安装包到团队 Gitea 的通用软件包仓库（Generic Package Registry）。
 *
 * 上传后会出现在仓库页的「软件包」标签：
 *   https://120.79.132.73/RegisTeamOfAI/llm_customer_service_branch/packages
 *
 * 用法（token 需在 Gitea「设置 → 应用 → 生成令牌」创建，勾选 package:write）：
 *   node scripts/upload-gitea-package.mjs <安装包路径> [版本号]
 *   GITEA_TOKEN=xxxx node scripts/upload-gitea-package.mjs Weflow_2.1.0_x64-setup.exe
 *
 * 版本号缺省时从文件名 Weflow_<版本>_x64-setup.exe 解析。
 * 环境变量：GITEA_TOKEN（必填）、GITEA_URL（缺省 https://120.79.132.73）、
 *          GITEA_OWNER（缺省 RegisTeamOfAI）、GITEA_PACKAGE（缺省 weflow-desktop）。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [, , filePath, versionArg] = process.argv;
if (!filePath) {
  console.error("用法: node scripts/upload-gitea-package.mjs <安装包路径> [版本号]");
  process.exit(1);
}
const token = process.env.GITEA_TOKEN;
if (!token) {
  console.error("缺少 GITEA_TOKEN 环境变量（Gitea 设置→应用→生成令牌，scope: package:write）");
  process.exit(1);
}

const GITEA_URL = (process.env.GITEA_URL ?? "https://120.79.132.73").replace(/\/$/, "");
const OWNER = process.env.GITEA_OWNER ?? "RegisTeamOfAI";
const PACKAGE = process.env.GITEA_PACKAGE ?? "weflow-desktop";

const name = basename(filePath);
const version =
  versionArg ?? name.match(/Weflow_([\d.]+)_x64-setup\.exe/)?.[1];
if (!version) {
  console.error(`无法从文件名解析版本号（${name}），请把版本号作为第二个参数传入`);
  process.exit(1);
}

const bytes = readFileSync(filePath);
const url = `${GITEA_URL}/api/v1/packages/${OWNER}/generic/${PACKAGE}/${version}/${encodeURIComponent(name)}`;

// 自签/私有 CA 的实例：curl -k 语义，Node 侧用 NODE_TLS_REJECT_UNAUTHORIZED 局部豁免
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `token ${token}`,
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.length),
  },
  body: new Uint8Array(bytes),
});

if (res.ok) {
  console.log(`✅ 已上传 ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) → ${PACKAGE}@${version}`);
  console.log(`   查看: ${GITEA_URL}/RegisTeamOfAI/llm_customer_service_branch/packages`);
} else {
  console.error(`❌ 上传失败 HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}
