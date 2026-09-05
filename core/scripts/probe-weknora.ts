/**
 * WeKnora 真实检索探针：验证真库里的 V9 资料是否可被召回。
 * 用法：npx tsx scripts/probe-weknora.ts "查询词"
 */
import { readFileSync } from "node:fs";
import { WeKnoraKnowledgeClient } from "../infrastructure/knowledge/weknora-knowledge-client.js";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
function env(name: string): string {
  const m = envText.match(new RegExp(`^${name}=(.*)$`, "m"));
  return m?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
}

const client = new WeKnoraKnowledgeClient({
  baseUrl: env("WEKNORA_BASE_URL") ?? "http://127.0.0.1:8080/api/v1",
  apiKey: env("WEKNORA_API_KEY") ?? "",
  timeoutMs: Number(env("WEKNORA_TIMEOUT_MS") ?? 15_000),
});

const query = process.argv[2] ?? "v9 打不开 启动失败";
const KB = "40e9c307-973e-461e-bcb3-c5e098634716";
const evidences = await client.search(query, { knowledgeBaseIds: [KB] });
console.log(`查询："${query}" → 命中 ${evidences.length} 条证据`);
for (const evidence of evidences.slice(0, 5)) {
  const text = (evidence.content ?? "").replace(/\s+/g, " ");
  console.log(`- [${evidence.title}] ${text.slice(0, 160)}`);
}
