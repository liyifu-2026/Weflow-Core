// Golden 再生成脚本：从 dist 产物渲染提示词快照到 tests/goldens/prompts.json。
// 跑法：npm run build && node scripts/render-golden-prompts.ts
// 仅在「协议有意变更、需重新固化基线」时使用——正常改动必须通过既有 golden 对比。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  customerSupportSystemPrompt,
  aiEmployeeSystemPrompt,
} from "../dist/prompt.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "tests", "goldens");
mkdirSync(outDir, { recursive: true });

const persona = `你是"小明"，某智能硬件公司的资深售后工程师，八年上门维修经验。
风格：直给、爱用工程师黑话但会照顾小白客户。口头禅："先别急，我们一步步来。"`;

const groupInstruction = `群内保持专业，不聊与产品无关的话题。`;

const goldens = {
  builtin_private_knowledge: customerSupportSystemPrompt(true, "private"),
  builtin_private_no_knowledge: customerSupportSystemPrompt(false, "private"),
  builtin_group_knowledge: customerSupportSystemPrompt(true, "group"),
  builtin_group_no_knowledge: customerSupportSystemPrompt(false, "group"),
  builtin_default_arg: customerSupportSystemPrompt(true),
  ai_private_knowledge: aiEmployeeSystemPrompt(persona, true, "private"),
  ai_private_no_knowledge: aiEmployeeSystemPrompt(persona, false, "private"),
  ai_group_knowledge: aiEmployeeSystemPrompt(persona, true, "group"),
  ai_group_knowledge_instruction: aiEmployeeSystemPrompt(persona, true, "group", groupInstruction),
  ai_group_blank_instruction: aiEmployeeSystemPrompt(persona, true, "group", "   "),
  ai_group_no_knowledge: aiEmployeeSystemPrompt(persona, false, "group"),
  ai_default_arg: aiEmployeeSystemPrompt(persona, true),
};

writeFileSync(
  join(outDir, "prompts.json"),
  JSON.stringify(goldens, null, 2) + "\n",
  "utf8",
);
console.log(`wrote ${Object.keys(goldens).length} goldens`);
