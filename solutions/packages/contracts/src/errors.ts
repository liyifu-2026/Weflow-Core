/**
 * 审计与错误码契约。
 */

export const ERROR_CODES = [
  "agent_execution_profile_unavailable",
  "invalid_manifest",
  "invalid_lock",
  "invalid_signature",
  "incompatible_platform",
  "missing_capability",
  "missing_secret",
  "missing_artifact",
  "duplicate_operation",
  "lease_conflict",
  "operation_not_found",
  "unsupported_component",
  "artifact_digest_mismatch",
  "artifact_path_escape",
  "artifact_not_found",
  "unsupported_registry",
  "missing_staging_root",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AuditEvent {
  eventId: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string;
  sourceIp?: string;
  metadata?: Record<string, unknown>;
}
