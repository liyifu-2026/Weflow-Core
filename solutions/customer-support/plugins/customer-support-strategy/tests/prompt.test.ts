import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  customerSupportSystemPrompt,
  aiEmployeeSystemPrompt,
} from "../dist/prompt.js";
import {
  NEXT_ACTIONS,
  NEXT_ACTION_VALUES,
  TOOL_NAMES_PROSE,
  WAIT_MS,
  builtinFieldSpec,
  aiOutputFormatHint,
} from "../dist/decision-protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldens = JSON.parse(
  readFileSync(join(here, "goldens", "prompts.json"), "utf8"),
) as Record<string, string>;

const persona = `你是"小明"，某智能硬件公司的资深售后工程师，八年上门维修经验。
风格：直给、爱用工程师黑话但会照顾小白客户。口头禅："先别急，我们一步步来。"`;
const groupInstruction = `群内保持专业，不聊与产品无关的话题。`;

const renderAll = (): Record<string, string> => ({
  builtin_private_knowledge: customerSupportSystemPrompt(true, "private"),
  builtin_private_no_knowledge: customerSupportSystemPrompt(false, "private"),
  builtin_group_knowledge: customerSupportSystemPrompt(true, "group"),
  builtin_group_no_knowledge: customerSupportSystemPrompt(false, "group"),
  builtin_default_arg: customerSupportSystemPrompt(true),
  ai_private_knowledge: aiEmployeeSystemPrompt(persona, true, "private"),
  ai_private_no_knowledge: aiEmployeeSystemPrompt(persona, false, "private"),
  ai_group_knowledge: aiEmployeeSystemPrompt(persona, true, "group"),
  ai_group_knowledge_instruction: aiEmployeeSystemPrompt(
    persona,
    true,
    "group",
    groupInstruction,
  ),
  ai_group_blank_instruction: aiEmployeeSystemPrompt(
    persona,
    true,
    "group",
    "   ",
  ),
  ai_group_no_knowledge: aiEmployeeSystemPrompt(persona, false, "group"),
  ai_default_arg: aiEmployeeSystemPrompt(persona, true),
});

test("golden 字节级快照：重构不得改变任何一条提示词的输出", () => {
  const rendered = renderAll();
  assert.deepEqual(
    Object.keys(rendered).sort(),
    Object.keys(goldens).sort(),
    "golden 键集合必须与渲染变体一致",
  );
  for (const [key, expected] of Object.entries(goldens)) {
    assert.equal(rendered[key], expected, `golden[${key}] 逐字节不一致`);
  }
});

test("协议原子：NEXT_ACTIONS 派生自 NEXT_ACTION_VALUES", () => {
  assert.equal(NEXT_ACTIONS, NEXT_ACTION_VALUES.join("|"));
  assert.ok(NEXT_ACTION_VALUES.includes("reply"));
});

test("漂移守卫：动作枚举与 wait/工具散文确实渲染进了提示词", () => {
  const fieldSpec = builtinFieldSpec(true);
  // 内置路径：枚举出现在输出格式段与字段段（≥2 次）
  assert.equal(
    customerSupportSystemPrompt(true, "private").split(NEXT_ACTIONS).length - 1,
    2,
  );
  // 字段段携带 wait 范围散文与工具名清单
  assert.ok(fieldSpec.includes(WAIT_MS.rangeProse));
  assert.ok(fieldSpec.includes(TOOL_NAMES_PROSE));
  // AI 员工路径的输出格式段也携带枚举
  assert.ok(aiOutputFormatHint().includes(NEXT_ACTIONS));
});

test("AI 员工路径：空白附加指令视为未配置（逐字节等同无指令）", () => {
  assert.equal(
    aiEmployeeSystemPrompt(persona, true, "group", "   "),
    aiEmployeeSystemPrompt(persona, true, "group"),
  );
});

test("共享对话约束两条路径都在场（AI 员工路径曾整块缺失）", () => {
  const aiPrompt = aiEmployeeSystemPrompt(persona, true, "private");
  const builtinPrompt = customerSupportSystemPrompt(true, "private");
  for (const prompt of [aiPrompt, builtinPrompt]) {
    assert.ok(prompt.includes("下一步必须等客户反馈后再发"));
    assert.ok(prompt.includes("不得逐字重复你上一条已发送的回复"));
    assert.ok(prompt.includes("不得向客户解释或猜测系统内部行为"));
  }
});
