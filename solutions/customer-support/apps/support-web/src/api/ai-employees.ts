import { api } from "../api";

export type AiEmployeeVersion = {
  versionId: string;
  definitionId: string;
  version: number;
  status: "draft" | "published" | "retired";
  prompt: string;
  createdAt: string;
  publishedAt?: string | null;
};

export type AiEmployee = {
  definitionId: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  /** 员工头像：平台 DiceBear 代理按 definitionId 确定性生成 */
  avatarUrl?: string | null;
  versions: AiEmployeeVersion[];
};

export type ContactAgentBinding = {
  contactId: string;
  definitionId: string;
  updatedAt: string;
  contact: {
    contactId: string;
    channelDisplayName: string | null;
    channelNickname: string | null;
    channelRemark: string | null;
    sharedAlias: string | null;
  };
  definition: Pick<
    AiEmployee,
    "definitionId" | "key" | "name" | "description" | "status"
  >;
};

export type ContactSummary = {
  contactId: string;
  channelDisplayName: string | null;
  channelNickname: string | null;
  channelRemark: string | null;
  sharedAlias: string | null;
};

export function listAiEmployees() {
  return api<{ employees: AiEmployee[] }>("/api/v1/agent/ai-employees");
}

export function createAiEmployee(input: {
  key: string;
  name: string;
  description?: string | null;
  prompt: string;
}) {
  return api<{
    employee: { definition: AiEmployee; version: AiEmployeeVersion };
  }>("/api/v1/agent/ai-employees", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAiEmployee(
  definitionId: string,
  input: { name?: string; description?: string | null },
) {
  return api<{ employee: AiEmployee }>(
    `/api/v1/agent/ai-employees/${encodeURIComponent(definitionId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function archiveAiEmployee(definitionId: string) {
  return api<{ employee: AiEmployee }>(
    `/api/v1/agent/ai-employees/${encodeURIComponent(definitionId)}/archive`,
    { method: "POST" },
  );
}

export function createAiEmployeeVersion(definitionId: string, prompt: string) {
  return api<{ version: AiEmployeeVersion }>(
    `/api/v1/agent/ai-employees/${encodeURIComponent(definitionId)}/versions`,
    { method: "POST", body: JSON.stringify({ prompt }) },
  );
}

export function updateAiEmployeeVersion(versionId: string, prompt: string) {
  return api<{ version: AiEmployeeVersion }>(
    `/api/v1/agent/ai-employees/versions/${encodeURIComponent(versionId)}`,
    { method: "PATCH", body: JSON.stringify({ prompt }) },
  );
}

export function publishAiEmployeeVersion(versionId: string) {
  return api<{ version: AiEmployeeVersion }>(
    `/api/v1/agent/ai-employees/versions/${encodeURIComponent(versionId)}/publish`,
    { method: "POST" },
  );
}

export function rollbackAiEmployeeVersion(versionId: string) {
  return api<{ version: AiEmployeeVersion }>(
    `/api/v1/agent/ai-employees/versions/${encodeURIComponent(versionId)}/rollback`,
    { method: "POST" },
  );
}

export function getWorkspaceAgentDefault() {
  return api<{ setting: { defaultDefinitionId: string | null } }>(
    "/api/v1/agent/workspace-default",
  );
}

export function setWorkspaceAgentDefault(definitionId: string | null) {
  return api<{ setting: { defaultDefinitionId: string | null } }>(
    "/api/v1/agent/workspace-default",
    { method: "PUT", body: JSON.stringify({ definitionId }) },
  );
}

export function listContactAgentBindings() {
  return api<{ bindings: ContactAgentBinding[] }>(
    "/api/v1/agent/contact-bindings",
  );
}

export function listContacts() {
  return api<{ contacts: ContactSummary[] }>("/api/v1/contacts?limit=100");
}

export function setContactAgentBinding(contactId: string, definitionId: string) {
  return api<{ binding: ContactAgentBinding }>(
    `/api/v1/agent/contact-bindings/${encodeURIComponent(contactId)}`,
    { method: "PUT", body: JSON.stringify({ definitionId }) },
  );
}

export function removeContactAgentBinding(contactId: string) {
  return api<{ ok: true }>(
    `/api/v1/agent/contact-bindings/${encodeURIComponent(contactId)}`,
    { method: "DELETE" },
  );
}
