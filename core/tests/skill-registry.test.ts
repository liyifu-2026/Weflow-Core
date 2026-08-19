import { describe, expect, it } from "vitest";
import {
  MapSkillRegistry,
  type AgentSkill,
} from "../modules/agent/contracts/agent-skill.js";

/** 本地定义的哑 Skill：不依赖任何 Solution 适配器 */
const testSkill: AgentSkill = {
  id: "test.skill",
  version: "1.0.0",
  beforeKnowledge: () => ({ hint: "before" }),
  afterKnowledge: () => ({ hint: "after" }),
};

describe("SkillRegistry", () => {
  it("stores and retrieves skills by id", () => {
    const registry = new MapSkillRegistry([testSkill]);

    expect(registry.has(testSkill.id)).toBe(true);
    expect(registry.get(testSkill.id)).toBe(testSkill);
    expect(registry.list()).toHaveLength(1);
  });

  it("returns undefined for unknown skills", () => {
    const registry = new MapSkillRegistry();
    expect(registry.get("missing.skill")).toBeUndefined();
  });

  it("supports dynamic register", () => {
    const registry = new MapSkillRegistry();
    registry.register(testSkill);
    expect(registry.get(testSkill.id)).toBe(testSkill);
  });

  it("exposes a stable skill id and version with decision helpers", () => {
    expect(testSkill.id).toBe("test.skill");
    expect(testSkill.version).toBe("1.0.0");
    expect(typeof testSkill.beforeKnowledge).toBe("function");
    expect(typeof testSkill.afterKnowledge).toBe("function");
    expect(testSkill.beforeKnowledge?.({})).toEqual({ hint: "before" });
  });
});
