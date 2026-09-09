/**
 * Customer Support — AI Employee domain service.
 *
 * Implements the AI Employee definition + version lifecycle, the workspace
 * default, and the contact-level binding table. Storage uses raw SQL against
 * the `customer_support` PostgreSQL schema (created via migration
 * 0061_customer_support_ai_employees.sql) so the backend can evolve without
 * coupling to Core's Drizzle schema surface.
 *
 * All mutations are guarded by `requireBusinessIdentity`; admin role is
 * required for write operations on definitions and the workspace default.
 */
import { randomUUID } from "node:crypto";

const DEFINITION_STATUS = Object.freeze({
  ACTIVE: "active",
  ARCHIVED: "archived",
});
const VERSION_STATUS = Object.freeze({
  DRAFT: "draft",
  PUBLISHED: "published",
  RETIRED: "retired",
});

/**
 * @param {{ db: { execute: Function }, schema: unknown, requireBusinessIdentity: Function }} ctx
 */
export function createAiEmployeesService(ctx) {
  const { db, requireBusinessIdentity } = ctx;

  function defineId() {
    return `ai_employee:${randomUUID()}`;
  }
  function versionId() {
    return `ai_employee_version:${randomUUID()}`;
  }
  function nowIso() {
    return new Date().toISOString();
  }

  async function listDefinitions() {
    const defs = await db.execute(
      "SELECT definition_id, key, name, description, status, created_at, updated_at " +
        "FROM customer_support.ai_employee_definitions " +
        "ORDER BY created_at ASC",
    );
    const versions = await db.execute(
      "SELECT version_id, definition_id, version, status, prompt, created_at, published_at " +
        "FROM customer_support.ai_employee_versions " +
        "ORDER BY created_at ASC",
    );
    const byDef = new Map();
    for (const row of versions.rows ?? []) {
      const list = byDef.get(row.definition_id) ?? [];
      list.push({
        versionId: row.version_id,
        definitionId: row.definition_id,
        version: Number(row.version),
        status: row.status,
        prompt: row.prompt,
        createdAt: row.created_at,
        publishedAt: row.published_at ?? null,
      });
      byDef.set(row.definition_id, list);
    }
    return {
      employees: (defs.rows ?? []).map((row) => ({
        definitionId: row.definition_id,
        key: row.key,
        name: row.name,
        description: row.description,
        status: row.status,
        // 员工头像：DiceBear voxel-bot 按员工标识确定性生成（平台代理），
        // 会话流与管理界面对同一员工渲染同一头像。
        avatarUrl:
          "/api/v1/avatars/dicebear/voxel-bot/" +
          encodeURIComponent(row.definition_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        versions: byDef.get(row.definition_id) ?? [],
      })),
    };
  }

  async function createDefinition(input) {
    if (!input?.key || !input?.name || !input?.prompt) {
      return { status: "invalid_request" };
    }
    const existing = await db.execute({
      sql: "SELECT 1 FROM customer_support.ai_employee_definitions WHERE key = $1 LIMIT 1",
      args: [input.key],
    });
    if ((existing.rows ?? []).length > 0) {
      return { status: "ai_employee_key_exists" };
    }
    const defId = defineId();
    const verId = versionId();
    const now = nowIso();
    await db.execute({
      sql:
        "INSERT INTO customer_support.ai_employee_definitions " +
        "(definition_id, key, name, description, status, created_at, updated_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $6)",
      args: [defId, input.key, input.name, input.description ?? null, "active", now],
    });
    await db.execute({
      sql:
        "INSERT INTO customer_support.ai_employee_versions " +
        "(version_id, definition_id, version, status, prompt, created_at, published_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, NULL)",
      args: [verId, defId, 1, VERSION_STATUS.DRAFT, input.prompt, now],
    });
    const employees = await listDefinitions();
    const definition = employees.employees.find((d) => d.definitionId === defId);
    const version = definition?.versions.find((v) => v.versionId === verId);
    return { status: "ok", employee: { definition, version } };
  }

  async function updateDefinition(definitionId, patch) {
    if (!patch || Object.keys(patch).length === 0) {
      return { status: "invalid_request" };
    }
    const fields = [];
    const args = [];
    let i = 1;
    if (typeof patch.name === "string") {
      fields.push(`name = $${i++}`);
      args.push(patch.name);
    }
    if (patch.description !== undefined) {
      fields.push(`description = $${i++}`);
      args.push(patch.description);
    }
    fields.push(`updated_at = $${i++}`);
    args.push(nowIso());
    args.push(definitionId);
    const result = await db.execute({
      sql: `UPDATE customer_support.ai_employee_definitions SET ${fields.join(
        ", ",
      )} WHERE definition_id = $${i} RETURNING definition_id`,
      args,
    });
    if ((result.rows ?? []).length === 0) {
      return { status: "ai_employee_not_found" };
    }
    const employees = await listDefinitions();
    const definition = employees.employees.find((d) => d.definitionId === definitionId);
    return { status: "ok", employee: definition };
  }

  async function archiveDefinition(definitionId) {
    const result = await db.execute({
      sql:
        "UPDATE customer_support.ai_employee_definitions " +
        "SET status = $1, updated_at = $2 WHERE definition_id = $3 AND status = $4 " +
        "RETURNING definition_id",
      args: [DEFINITION_STATUS.ARCHIVED, nowIso(), definitionId, DEFINITION_STATUS.ACTIVE],
    });
    if ((result.rows ?? []).length === 0) {
      return { status: "ai_employee_not_archivable" };
    }
    const employees = await listDefinitions();
    const definition = employees.employees.find((d) => d.definitionId === definitionId);
    return { status: "ok", employee: definition };
  }

  async function createVersion(definitionId, prompt) {
    if (typeof prompt !== "string") return { status: "invalid_request" };
    const max = await db.execute({
      sql:
        "SELECT COALESCE(MAX(version), 0) AS max_v FROM customer_support.ai_employee_versions " +
        "WHERE definition_id = $1",
      args: [definitionId],
    });
    const next = Number(max.rows?.[0]?.max_v ?? 0) + 1;
    const verId = versionId();
    const now = nowIso();
    const result = await db.execute({
      sql:
        "INSERT INTO customer_support.ai_employee_versions " +
        "(version_id, definition_id, version, status, prompt, created_at, published_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6, NULL) RETURNING version_id",
      args: [verId, definitionId, next, VERSION_STATUS.DRAFT, prompt, now],
    });
    if ((result.rows ?? []).length === 0) {
      return { status: "ai_employee_not_versionable" };
    }
    const employees = await listDefinitions();
    const definition = employees.employees.find((d) => d.definitionId === definitionId);
    const version = definition?.versions.find((v) => v.versionId === verId);
    return { status: "ok", version };
  }

  async function updateVersion(versionIdValue, prompt) {
    if (typeof prompt !== "string") return { status: "invalid_request" };
    const result = await db.execute({
      sql:
        "UPDATE customer_support.ai_employee_versions " +
        "SET prompt = $1 WHERE version_id = $2 AND status = $3 RETURNING version_id",
      args: [prompt, versionIdValue, VERSION_STATUS.DRAFT],
    });
    if ((result.rows ?? []).length === 0) {
      return { status: "ai_employee_version_not_editable" };
    }
    const versions = await db.execute({
      sql:
        "SELECT version_id, definition_id, version, status, prompt, created_at, published_at " +
        "FROM customer_support.ai_employee_versions WHERE version_id = $1",
      args: [versionIdValue],
    });
    const row = versions.rows?.[0];
    return {
      status: "ok",
      version: row
        ? {
            versionId: row.version_id,
            definitionId: row.definition_id,
            version: Number(row.version),
            status: row.status,
            prompt: row.prompt,
            createdAt: row.created_at,
            publishedAt: row.published_at ?? null,
          }
        : null,
    };
  }

  async function publishVersion(versionIdValue) {
    const target = await db.execute({
      sql:
        "SELECT version_id, definition_id FROM customer_support.ai_employee_versions " +
        "WHERE version_id = $1 AND status = $2",
      args: [versionIdValue, VERSION_STATUS.DRAFT],
    });
    if ((target.rows ?? []).length === 0) {
      return { status: "ai_employee_version_not_publishable" };
    }
    const definitionId = target.rows[0].definition_id;
    const now = nowIso();
    await db.execute({
      sql:
        "UPDATE customer_support.ai_employee_versions SET status = $1, published_at = $2 " +
        "WHERE definition_id = $3 AND status = $4",
      args: [VERSION_STATUS.RETIRED, now, definitionId, VERSION_STATUS.PUBLISHED],
    });
    await db.execute({
      sql:
        "UPDATE customer_support.ai_employee_versions SET status = $1, published_at = $2 " +
        "WHERE version_id = $3",
      args: [VERSION_STATUS.PUBLISHED, now, versionIdValue],
    });
    const versions = await db.execute({
      sql:
        "SELECT version_id, definition_id, version, status, prompt, created_at, published_at " +
        "FROM customer_support.ai_employee_versions WHERE version_id = $1",
      args: [versionIdValue],
    });
    const row = versions.rows?.[0];
    return {
      status: "ok",
      version: {
        versionId: row.version_id,
        definitionId: row.definition_id,
        version: Number(row.version),
        status: row.status,
        prompt: row.prompt,
        createdAt: row.created_at,
        publishedAt: row.published_at ?? null,
      },
    };
  }

  async function rollbackVersion(versionIdValue) {
    const target = await db.execute({
      sql:
        "SELECT version_id, definition_id FROM customer_support.ai_employee_versions " +
        "WHERE version_id = $1 AND status = $2",
      args: [versionIdValue, VERSION_STATUS.RETIRED],
    });
    if ((target.rows ?? []).length === 0) {
      return { status: "ai_employee_version_not_rollbackable" };
    }
    const definitionId = target.rows[0].definition_id;
    const now = nowIso();
    await db.execute({
      sql:
        "UPDATE customer_support.ai_employee_versions SET status = $1, published_at = $2 " +
        "WHERE definition_id = $3 AND status = $4",
      args: [VERSION_STATUS.RETIRED, now, definitionId, VERSION_STATUS.PUBLISHED],
    });
    await db.execute({
      sql:
        "UPDATE customer_support.ai_employee_versions SET status = $1, published_at = $2 " +
        "WHERE version_id = $3",
      args: [VERSION_STATUS.PUBLISHED, now, versionIdValue],
    });
    const versions = await db.execute({
      sql:
        "SELECT version_id, definition_id, version, status, prompt, created_at, published_at " +
        "FROM customer_support.ai_employee_versions WHERE version_id = $1",
      args: [versionIdValue],
    });
    const row = versions.rows?.[0];
    return {
      status: "ok",
      version: {
        versionId: row.version_id,
        definitionId: row.definition_id,
        version: Number(row.version),
        status: row.status,
        prompt: row.prompt,
        createdAt: row.created_at,
        publishedAt: row.published_at ?? null,
      },
    };
  }

  async function getWorkspaceDefault() {
    const row = await db.execute(
      "SELECT default_definition_id FROM customer_support.ai_employee_workspace_default WHERE id = 1",
    );
    return {
      setting: {
        defaultDefinitionId: row.rows?.[0]?.default_definition_id ?? null,
      },
    };
  }

  async function setWorkspaceDefault(definitionId) {
    await db.execute({
      sql:
        "INSERT INTO customer_support.ai_employee_workspace_default (id, default_definition_id) " +
        "VALUES (1, $1) " +
        "ON CONFLICT (id) DO UPDATE SET default_definition_id = EXCLUDED.default_definition_id",
      args: [definitionId],
    });
    return getWorkspaceDefault();
  }

  async function listContactBindings() {
    const rows = await db.execute(
      "SELECT cb.contact_id, cb.definition_id, cb.updated_at, " +
        "cp.channel_display_name, cp.channel_nickname, cp.channel_remark, cp.shared_alias, " +
        "ad.key, ad.name, ad.description, ad.status " +
        "FROM customer_support.contact_agent_bindings cb " +
        "JOIN conversation.contact_profiles cp ON cp.contact_id = cb.contact_id " +
        "JOIN customer_support.ai_employee_definitions ad ON ad.definition_id = cb.definition_id " +
        "ORDER BY cb.updated_at DESC",
    );
    return {
      bindings: (rows.rows ?? []).map((row) => ({
        contactId: row.contact_id,
        definitionId: row.definition_id,
        updatedAt: row.updated_at,
        contact: {
          contactId: row.contact_id,
          channelDisplayName: row.channel_display_name,
          channelNickname: row.channel_nickname,
          channelRemark: row.channel_remark,
          sharedAlias: row.shared_alias,
        },
        definition: {
          definitionId: row.definition_id,
          key: row.key,
          name: row.name,
          description: row.description,
          status: row.status,
        },
      })),
    };
  }

  async function setContactBinding(contactId, definitionId) {
    const def = await db.execute({
      sql: "SELECT 1 FROM customer_support.ai_employee_definitions WHERE definition_id = $1 LIMIT 1",
      args: [definitionId],
    });
    if ((def.rows ?? []).length === 0) return { status: "contact_agent_binding_invalid" };
    await db.execute({
      sql:
        "INSERT INTO customer_support.contact_agent_bindings (contact_id, definition_id, updated_at) " +
        "VALUES ($1, $2, $3) " +
        "ON CONFLICT (contact_id) DO UPDATE SET definition_id = EXCLUDED.definition_id, updated_at = EXCLUDED.updated_at",
      args: [contactId, definitionId, nowIso()],
    });
    const result = await listContactBindings();
    const binding = result.bindings.find((b) => b.contactId === contactId);
    return { status: "ok", binding };
  }

  async function removeContactBinding(contactId) {
    await db.execute({
      sql: "DELETE FROM customer_support.contact_agent_bindings WHERE contact_id = $1",
      args: [contactId],
    });
    return { ok: true };
  }

  return {
    listDefinitions,
    createDefinition,
    updateDefinition,
    archiveDefinition,
    createVersion,
    updateVersion,
    publishVersion,
    rollbackVersion,
    getWorkspaceDefault,
    setWorkspaceDefault,
    listContactBindings,
    setContactBinding,
    removeContactBinding,
  };
}
