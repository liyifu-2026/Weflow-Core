import type { SkillRegistration } from "@weflow-leaif/plugin-sdk";
import { ProductTroubleshootingSkill } from "./product-troubleshooting-skill.js";

/**
 * Product Troubleshooting Skill plugin.
 *
 * Real implementation migrated from Core; the plugin is now self-contained and
 * depends only on @weflow/contracts and @weflow/plugin-sdk.
 *
 * Export contract: the platform Agent Worker loads skills from
 * SKILL_PLUGIN_PATH and expects a named export `skill` (AgentSkill). Keep this
 * export name stable so the same build artifact can be inserted into any
 * Weflow platform instance.
 */
const troubleshootingSkill = new ProductTroubleshootingSkill();

export const skill: SkillRegistration = {
  id: "weflow.customer-support/product-troubleshooting",
  version: "1.0.0",
  beforeKnowledge: (input) =>
    troubleshootingSkill.beforeKnowledge(
      input as Parameters<typeof troubleshootingSkill.beforeKnowledge>[0],
    ),
  afterKnowledge: (input) =>
    troubleshootingSkill.afterKnowledge(
      input as Parameters<typeof troubleshootingSkill.afterKnowledge>[0],
    ),
};
