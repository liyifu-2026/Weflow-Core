import { api } from "../api";

export type PromptMap = {
  default: string | null;
  contacts: Record<string, string>;
  conversations: Record<string, string>;
};

export function getPrompts(): Promise<PromptMap> {
  return api<PromptMap>("/customer-support/prompts");
}

export function savePrompts(input: PromptMap): Promise<PromptMap> {
  return api<PromptMap>("/customer-support/prompts", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}
