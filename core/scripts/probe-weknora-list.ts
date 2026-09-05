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
  timeoutMs: 15_000,
});
const KB = "40e9c307-973e-461e-bcb3-c5e098634716";
const docs = await client.listKnowledgeDocuments(KB);
for (const d of docs) {
  if (String(d.title).includes("V9") || String(d.title).includes("无法启动")) {
    console.log(JSON.stringify(d, null, 1));
  }
}
