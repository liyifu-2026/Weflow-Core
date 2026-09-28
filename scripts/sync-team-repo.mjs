#!/usr/bin/env node
/**
 * 把 weflow 主干镜像到团队库 ../llm_customer_service_branch/code/。
 *
 * 规则：
 * 1. 以 weflow `git ls-files` 为权威清单复制/覆盖；
 * 2. 主干已删除的文件**不删除**团队侧同名文件——团队库可能有独有文件
 *    （如 runtimes/channel-host-wechat/wechatauto/rhythm.py、tools/selftest.py，
 *    均为团队通道工作的成果，2026-09-28 曾被误删两次后恢复）；
 *    删除必须人工确认后手动执行。
 * 3. 只对 git 跟踪文件操作，不碰 node_modules/dist 等。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WF = process.cwd();
const TEAM = process.env.TEAM_REPO ?? path.resolve(WF, "../llm_customer_service_branch");
const CODE = path.join(TEAM, "code");
const KEEP_TEAM_ONLY = new Set([
  "runtimes/channel-host-wechat/wechatauto/rhythm.py",
  "runtimes/channel-host-wechat/tools/selftest.py",
  "runtimes/channel-host-wechat/GUIDE.md",
  "runtimes/channel-host-wechat/docs/architecture-overview.png",
  "runtimes/channel-host-wechat/docs/db-read-pipeline.png",
]);

const files = execSync("git -c core.quotepath=false ls-files", { cwd: WF, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

let copied = 0;
for (const f of files) {
  const src = path.join(WF, f);
  const dst = path.join(CODE, f);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied += 1;
}
console.log(`copied/updated: ${copied}`);
console.log("team-only files preserved:", [...KEEP_TEAM_ONLY].join(", "));
