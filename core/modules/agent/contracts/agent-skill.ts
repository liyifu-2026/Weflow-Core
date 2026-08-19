/**
 * Generic Agent Skill contract.
 *
 * A Skill is a pure decision helper selected by ID through a SkillRegistry.
 * It must not write business state, call the model, or access the database.
 */

export interface AgentSkill {
  id: string;
  version: string;
  beforeKnowledge?(input: unknown): unknown;
  afterKnowledge?(input: unknown): unknown;
  execute?(input: unknown, context: unknown): unknown;
}

export interface SkillRegistry {
  get(skillId: string): AgentSkill | undefined;
  has(skillId: string): boolean;
  list(): AgentSkill[];
  register(skill: AgentSkill): void;
}

export class MapSkillRegistry implements SkillRegistry {
  private readonly skills = new Map<string, AgentSkill>();

  public constructor(skills: readonly AgentSkill[] = []) {
    for (const skill of skills) {
      this.skills.set(skill.id, skill);
    }
  }

  public get(skillId: string): AgentSkill | undefined {
    return this.skills.get(skillId);
  }

  public has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  public list(): AgentSkill[] {
    return [...this.skills.values()];
  }

  public register(skill: AgentSkill): void {
    this.skills.set(skill.id, skill);
  }
}
