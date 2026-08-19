import {
  addIssue,
  fail,
  hasUniqueIds,
  isOneOf,
  isRecord,
  ok,
  parseStrictObject,
  readBoolean,
  readNumber,
  readOptionalString,
  readString,
  readStringArray,
  type ValidationResult,
} from "./validate.js";
import type {
  ArtifactType,
  ConsoleExtension,
  DashboardContribution,
  DashboardPosition,
  ExecutionProfile,
  ExecutionProfileSkillRef,
  HealthCheck,
  HealthCheckType,
  PermissionAction,
  PluginApiRoute,
  SecretSlot,
  SettingCategory,
  SettingContribution,
  SettingField,
  SettingFieldOption,
  SettingFieldType,
  SolutionApplication,
  SolutionApplicationType,
  SolutionArtifact,
  SolutionBackend,
  SolutionCompatibility,
  SolutionDependencies,
  SolutionManifestV1,
  SolutionMetadata,
  SolutionPermission,
  SolutionResource,
  SolutionResourceType,
} from "./types.js";

const MANIFEST_KEYS = new Set([
  "apiVersion",
  "kind",
  "metadata",
  "compatibility",
  "dependencies",
  "artifacts",
  "permissions",
  "configuration",
  "secretSlots",
  "resources",
  "executionProfiles",
  "applications",
  "healthChecks",
  "backend",
  "consoleExtensions",
]);

const BACKEND_KEYS = new Set(["entry"]);
const METADATA_KEYS = new Set(["id", "name", "version", "publisher"]);
const COMPATIBILITY_KEYS = new Set(["platform", "pluginSdk"]);
const DEPENDENCIES_KEYS = new Set(["capabilities", "solutions"]);
const ARTIFACT_KEYS = new Set(["id", "type", "ref", "digest", "size"]);
const PERMISSION_KEYS = new Set(["id", "resource", "action", "description"]);
const SECRET_SLOT_KEYS = new Set(["name", "kind", "required", "description"]);
const RESOURCE_KEYS = new Set(["id", "type", "ref"]);
const EXECUTION_PROFILE_KEYS = new Set([
  "id",
  "strategyRef",
  "maxModelCalls",
  "maxToolCalls",
  "timeoutSeconds",
  "allowedTools",
  "skills",
]);
const SKILL_REF_KEYS = new Set(["id", "version"]);
const APPLICATION_KEYS = new Set(["id", "type", "entry"]);
const CONSOLE_EXTENSION_KEYS = new Set([
  "id",
  "title",
  "entry",
  "nav",
  "settings",
  "dashboard",
  "settingsSchema",
  "settingsContributions",
  "dashboardContributions",
  "apiRoutes",
  "eventSubscriptions",
]);
const CONSOLE_EXTENSION_NAV_KEYS = new Set([
  "group",
  "label",
  "icon",
  "order",
]);
const SETTING_FIELD_KEYS = new Set([
  "key",
  "label",
  "type",
  "required",
  "default",
  "placeholder",
  "options",
]);
const SETTING_FIELD_OPTION_KEYS = new Set(["label", "value"]);
const SETTING_CONTRIBUTION_KEYS = new Set([
  "id",
  "category",
  "label",
  "component",
  "order",
  "schema",
]);
const DASHBOARD_CONTRIBUTION_KEYS = new Set([
  "id",
  "title",
  "component",
  "defaultPosition",
  "refreshInterval",
  "api",
]);
const DASHBOARD_POSITION_KEYS = new Set(["x", "y", "w", "h"]);
const PLUGIN_API_ROUTE_KEYS = new Set(["prefix", "target"]);
const HEALTH_CHECK_KEYS = new Set(["id", "type", "target", "timeoutSeconds"]);

const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "plugin",
  "app",
  "container",
  "resource",
];
const SETTING_FIELD_TYPES: readonly SettingFieldType[] = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "secret",
];
const SETTING_CATEGORIES: readonly SettingCategory[] = [
  "general",
  "integrations",
  "security",
  "advanced",
];
const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  "read",
  "write",
  "execute",
  "admin",
];
const RESOURCE_TYPES: readonly SolutionResourceType[] = [
  "schema",
  "ledger",
  "role",
  "agent-definition",
  "policy",
  "evaluation",
  "knowledge-template",
];
const APPLICATION_TYPES: readonly SolutionApplicationType[] = [
  "web",
  "bff",
  "mobile",
  "worker",
];
const HEALTH_CHECK_TYPES: readonly HealthCheckType[] = ["http", "tcp", "process"];

const ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function isValidSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

function readId(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: { path: string; message: string }[],
): string | undefined {
  const value = readString(obj, key, path, issues);
  if (value !== undefined && !isValidId(value)) {
    addIssue(issues, `${path}.${key}`, `invalid id "${value}"`);
    return undefined;
  }
  return value;
}

function readVersion(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: { path: string; message: string }[],
): string | undefined {
  const value = readString(obj, key, path, issues);
  if (value !== undefined && !isValidSemVer(value)) {
    addIssue(issues, `${path}.${key}`, `invalid semantic version "${value}"`);
    return undefined;
  }
  return value;
}

function parseMetadata(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionMetadata | null {
  const obj = parseStrictObject(input, METADATA_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const name = readString(obj, "name", path, issues);
  const version = readVersion(obj, "version", path, issues);
  const publisher = readString(obj, "publisher", path, issues);
  if (!id || !name || !version || !publisher) return null;
  return { id, name, version, publisher };
}

function parseBackend(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionBackend | null {
  const obj = parseStrictObject(input, BACKEND_KEYS, path, issues);
  if (!obj) return null;
  const entry = readString(obj, "entry", path, issues);
  if (!entry) return null;
  return { entry };
}

function parseCompatibility(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionCompatibility | null {
  const obj = parseStrictObject(input, COMPATIBILITY_KEYS, path, issues);
  if (!obj) return null;
  const platform = readString(obj, "platform", path, issues);
  const pluginSdk = readOptionalString(obj, "pluginSdk", path, issues);
  if (!platform) return null;
  return pluginSdk === undefined ? { platform } : { platform, pluginSdk };
}

function parseDependencies(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionDependencies | null {
  const obj = parseStrictObject(input, DEPENDENCIES_KEYS, path, issues);
  if (!obj) return null;
  const capabilities = readStringArray(obj, "capabilities", path, issues, {
    unique: true,
  });
  const solutions = readStringArray(obj, "solutions", path, issues, {
    unique: true,
  });
  return { capabilities, solutions };
}

function parseArtifact(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionArtifact | null {
  const obj = parseStrictObject(input, ARTIFACT_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const typeValue = obj.type;
  if (!isOneOf(typeValue, ARTIFACT_TYPES)) {
    addIssue(issues, `${path}.type`, "unknown artifact type");
  }
  const type = isOneOf(typeValue, ARTIFACT_TYPES) ? typeValue : undefined;
  const ref = readString(obj, "ref", path, issues);
  const digest = readOptionalString(obj, "digest", path, issues);
  const size = readNumber(obj, "size", path, issues, {
    required: false,
    integer: true,
    min: 0,
  });
  if (!id || !type || !ref) return null;
  return {
    id,
    type,
    ref,
    ...(digest === undefined ? {} : { digest }),
    ...(size === undefined ? {} : { size }),
  };
}

function parsePermission(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionPermission | null {
  const obj = parseStrictObject(input, PERMISSION_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const resource = readString(obj, "resource", path, issues);
  const actionValue = obj.action;
  if (!isOneOf(actionValue, PERMISSION_ACTIONS)) {
    addIssue(issues, `${path}.action`, "unknown permission action");
  }
  const action = isOneOf(actionValue, PERMISSION_ACTIONS)
    ? actionValue
    : undefined;
  const description = readOptionalString(obj, "description", path, issues);
  if (!id || !resource || !action) return null;
  return {
    id,
    resource,
    action,
    ...(description === undefined ? {} : { description }),
  };
}

function parseSecretSlot(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SecretSlot | null {
  const obj = parseStrictObject(input, SECRET_SLOT_KEYS, path, issues);
  if (!obj) return null;
  const name = readId(obj, "name", path, issues);
  const kindValue = obj.kind;
  if (kindValue !== "env" && kindValue !== "file") {
    addIssue(issues, `${path}.kind`, "secret slot kind must be env or file");
  }
  const kind = kindValue === "env" || kindValue === "file" ? kindValue : undefined;
  const required = readBoolean(obj, "required", path, issues);
  const description = readOptionalString(obj, "description", path, issues);
  if (!name || !kind || required === undefined) return null;
  return {
    name,
    kind,
    required,
    ...(description === undefined ? {} : { description }),
  };
}

function parseResource(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionResource | null {
  const obj = parseStrictObject(input, RESOURCE_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const typeValue = obj.type;
  if (!isOneOf(typeValue, RESOURCE_TYPES)) {
    addIssue(issues, `${path}.type`, "unknown resource type");
  }
  const type = isOneOf(typeValue, RESOURCE_TYPES) ? typeValue : undefined;
  const ref = readString(obj, "ref", path, issues);
  if (!id || !type || !ref) return null;
  return { id, type, ref };
}

function parseSkillRef(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): ExecutionProfileSkillRef | null {
  const obj = parseStrictObject(input, SKILL_REF_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const version = readOptionalString(obj, "version", path, issues);
  if (!id) return null;
  return version === undefined ? { id } : { id, version };
}

function parseExecutionProfile(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): ExecutionProfile | null {
  const obj = parseStrictObject(input, EXECUTION_PROFILE_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const strategyRef = readString(obj, "strategyRef", path, issues);
  const maxModelCalls = readNumber(obj, "maxModelCalls", path, issues, {
    integer: true,
    min: 1,
  });
  const maxToolCalls = readNumber(obj, "maxToolCalls", path, issues, {
    integer: true,
    min: 0,
  });
  const timeoutSeconds = readNumber(obj, "timeoutSeconds", path, issues, {
    integer: true,
    min: 1,
  });
  const allowedTools = readStringArray(obj, "allowedTools", path, issues, {
    unique: true,
  });
  const skillsInput = obj.skills;
  const skills: ExecutionProfileSkillRef[] = [];
  if (skillsInput === undefined) {
    addIssue(issues, `${path}.skills`, "field is required");
  } else if (!Array.isArray(skillsInput)) {
    addIssue(issues, `${path}.skills`, "expected an array");
  } else {
    skillsInput.forEach((item, index) => {
      const skill = parseSkillRef(item, `${path}.skills[${index}]`, issues);
      if (skill) skills.push(skill);
    });
  }
  if (
    !id ||
    !strategyRef ||
    maxModelCalls === undefined ||
    maxToolCalls === undefined ||
    timeoutSeconds === undefined
  ) {
    return null;
  }
  return {
    id,
    strategyRef,
    maxModelCalls,
    maxToolCalls,
    timeoutSeconds,
    allowedTools,
    skills,
  };
}

function parseApplication(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SolutionApplication | null {
  const obj = parseStrictObject(input, APPLICATION_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const typeValue = obj.type;
  if (!isOneOf(typeValue, APPLICATION_TYPES)) {
    addIssue(issues, `${path}.type`, "unknown application type");
  }
  const type = isOneOf(typeValue, APPLICATION_TYPES) ? typeValue : undefined;
  const entry = readString(obj, "entry", path, issues);
  if (!id || !type || !entry) return null;
  return { id, type, entry };
}

function parseHealthCheck(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): HealthCheck | null {
  const obj = parseStrictObject(input, HEALTH_CHECK_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const typeValue = obj.type;
  if (!isOneOf(typeValue, HEALTH_CHECK_TYPES)) {
    addIssue(issues, `${path}.type`, "unknown health check type");
  }
  const type = isOneOf(typeValue, HEALTH_CHECK_TYPES) ? typeValue : undefined;
  const target = readString(obj, "target", path, issues);
  const timeoutSeconds = readNumber(obj, "timeoutSeconds", path, issues, {
    required: false,
    integer: true,
    min: 1,
  });
  if (!id || !type || !target) return null;
  return {
    id,
    type,
    target,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
}

function parseConsoleExtensionNav(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): ConsoleExtension["nav"] | undefined {
  if (input === undefined) return undefined;
  const obj = parseStrictObject(input, CONSOLE_EXTENSION_NAV_KEYS, path, issues);
  if (!obj) return undefined;
  const label = readString(obj, "label", path, issues);
  if (!label) return undefined;
  const group = readOptionalString(obj, "group", path, issues);
  const icon = readOptionalString(obj, "icon", path, issues);
  const order = readNumber(obj, "order", path, issues, {
    required: false,
    integer: true,
    min: 0,
  });
  return {
    ...(group === undefined ? {} : { group }),
    label,
    ...(icon === undefined ? {} : { icon }),
    ...(order === undefined ? {} : { order }),
  };
}

function parseSettingFieldOption(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SettingFieldOption | null {
  const obj = parseStrictObject(input, SETTING_FIELD_OPTION_KEYS, path, issues);
  if (!obj) return null;
  const label = readString(obj, "label", path, issues);
  const value = readString(obj, "value", path, issues);
  if (!label || !value) return null;
  return { label, value };
}

function parseSettingField(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SettingField | null {
  const obj = parseStrictObject(input, SETTING_FIELD_KEYS, path, issues);
  if (!obj) return null;
  const key = readId(obj, "key", path, issues);
  const label = readString(obj, "label", path, issues);
  const typeValue = obj.type;
  if (!isOneOf(typeValue, SETTING_FIELD_TYPES)) {
    addIssue(issues, `${path}.type`, "unknown setting field type");
  }
  const type = isOneOf(typeValue, SETTING_FIELD_TYPES)
    ? typeValue
    : undefined;
  const required = readBoolean(obj, "required", path, issues, false);
  const defaultValue = obj.default;
  const placeholder = readOptionalString(obj, "placeholder", path, issues);
  const optionsInput = obj.options;
  const options: SettingFieldOption[] = [];
  if (optionsInput !== undefined) {
    if (!Array.isArray(optionsInput)) {
      addIssue(issues, `${path}.options`, "expected an array");
    } else {
      optionsInput.forEach((item, index) => {
        const option = parseSettingFieldOption(
          item,
          `${path}.options[${index}]`,
          issues,
        );
        if (option) options.push(option);
      });
    }
  }
  if (!key || !label || !type) return null;
  const defaultSafe =
    typeof defaultValue === "string" ||
    typeof defaultValue === "number" ||
    typeof defaultValue === "boolean"
      ? defaultValue
      : undefined;
  return {
    key,
    label,
    type,
    ...(required === undefined ? {} : { required }),
    ...(defaultSafe === undefined ? {} : { default: defaultSafe }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(options.length === 0 ? {} : { options }),
  };
}

function parseSettingContribution(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): SettingContribution | null {
  const obj = parseStrictObject(input, SETTING_CONTRIBUTION_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const categoryValue = obj.category;
  if (!isOneOf(categoryValue, SETTING_CATEGORIES)) {
    addIssue(issues, `${path}.category`, "unknown setting category");
  }
  const category = isOneOf(categoryValue, SETTING_CATEGORIES)
    ? categoryValue
    : undefined;
  const label = readString(obj, "label", path, issues);
  const component = readOptionalString(obj, "component", path, issues);
  const order = readNumber(obj, "order", path, issues, {
    required: false,
    integer: true,
    min: 0,
  });
  const schemaInput = obj.schema;
  const schema: SettingField[] = [];
  if (schemaInput !== undefined) {
    if (!Array.isArray(schemaInput)) {
      addIssue(issues, `${path}.schema`, "expected an array");
    } else {
      schemaInput.forEach((item, index) => {
        const field = parseSettingField(item, `${path}.schema[${index}]`, issues);
        if (field) schema.push(field);
      });
    }
  }
  if (!id || !category || !label) return null;
  return {
    id,
    category,
    label,
    ...(component === undefined ? {} : { component }),
    ...(order === undefined ? {} : { order }),
    ...(schema.length === 0 ? {} : { schema }),
  };
}

function parseDashboardPosition(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): DashboardPosition | undefined {
  if (input === undefined) return undefined;
  const obj = parseStrictObject(input, DASHBOARD_POSITION_KEYS, path, issues);
  if (!obj) return undefined;
  const x = readNumber(obj, "x", path, issues, { required: true, integer: true, min: 0 });
  const y = readNumber(obj, "y", path, issues, { required: true, integer: true, min: 0 });
  const w = readNumber(obj, "w", path, issues, { required: true, integer: true, min: 1 });
  const h = readNumber(obj, "h", path, issues, { required: true, integer: true, min: 1 });
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x, y, w, h };
}

function parseDashboardContribution(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): DashboardContribution | null {
  const obj = parseStrictObject(input, DASHBOARD_CONTRIBUTION_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const title = readString(obj, "title", path, issues);
  const component = readOptionalString(obj, "component", path, issues);
  const defaultPosition = parseDashboardPosition(
    obj.defaultPosition,
    `${path}.defaultPosition`,
    issues,
  );
  const refreshInterval = readNumber(obj, "refreshInterval", path, issues, {
    required: false,
    integer: true,
    min: 1000,
  });
  const api = readOptionalString(obj, "api", path, issues);
  if (!id || !title) return null;
  return {
    id,
    title,
    ...(component === undefined ? {} : { component }),
    ...(defaultPosition === undefined ? {} : { defaultPosition }),
    ...(refreshInterval === undefined ? {} : { refreshInterval }),
    ...(api === undefined ? {} : { api }),
  };
}

function parsePluginApiRoute(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): PluginApiRoute | null {
  const obj = parseStrictObject(input, PLUGIN_API_ROUTE_KEYS, path, issues);
  if (!obj) return null;
  const prefix = readString(obj, "prefix", path, issues);
  const target = readString(obj, "target", path, issues);
  if (!prefix || !target) return null;
  return { prefix, target };
}

function parseConsoleExtension(
  input: unknown,
  path: string,
  issues: { path: string; message: string }[],
): ConsoleExtension | null {
  const obj = parseStrictObject(input, CONSOLE_EXTENSION_KEYS, path, issues);
  if (!obj) return null;
  const id = readId(obj, "id", path, issues);
  const title = readString(obj, "title", path, issues);
  const entry = readOptionalString(obj, "entry", path, issues);
  const nav = parseConsoleExtensionNav(obj.nav, `${path}.nav`, issues);
  const settings = readBoolean(obj, "settings", path, issues, false);
  const dashboard = readBoolean(obj, "dashboard", path, issues, false);
  const settingsSchemaInput = obj.settingsSchema;
  const settingsSchema: SettingField[] = [];
  if (settingsSchemaInput !== undefined) {
    if (!Array.isArray(settingsSchemaInput)) {
      addIssue(issues, `${path}.settingsSchema`, "expected an array");
    } else {
      settingsSchemaInput.forEach((item, index) => {
        const field = parseSettingField(
          item,
          `${path}.settingsSchema[${index}]`,
          issues,
        );
        if (field) settingsSchema.push(field);
      });
    }
  }
  const settingsContributionsInput = obj.settingsContributions;
  const settingsContributions: SettingContribution[] = [];
  if (settingsContributionsInput !== undefined) {
    if (!Array.isArray(settingsContributionsInput)) {
      addIssue(issues, `${path}.settingsContributions`, "expected an array");
    } else {
      settingsContributionsInput.forEach((item, index) => {
        const contribution = parseSettingContribution(
          item,
          `${path}.settingsContributions[${index}]`,
          issues,
        );
        if (contribution) settingsContributions.push(contribution);
      });
    }
  }
  const dashboardContributionsInput = obj.dashboardContributions;
  const dashboardContributions: DashboardContribution[] = [];
  if (dashboardContributionsInput !== undefined) {
    if (!Array.isArray(dashboardContributionsInput)) {
      addIssue(issues, `${path}.dashboardContributions`, "expected an array");
    } else {
      dashboardContributionsInput.forEach((item, index) => {
        const contribution = parseDashboardContribution(
          item,
          `${path}.dashboardContributions[${index}]`,
          issues,
        );
        if (contribution) dashboardContributions.push(contribution);
      });
    }
  }
  const apiRoutesInput = obj.apiRoutes;
  const apiRoutes: PluginApiRoute[] = [];
  if (apiRoutesInput !== undefined) {
    if (!Array.isArray(apiRoutesInput)) {
      addIssue(issues, `${path}.apiRoutes`, "expected an array");
    } else {
      apiRoutesInput.forEach((item, index) => {
        const route = parsePluginApiRoute(
          item,
          `${path}.apiRoutes[${index}]`,
          issues,
        );
        if (route) apiRoutes.push(route);
      });
    }
  }
  const eventSubscriptions = readStringArray(obj, "eventSubscriptions", path, issues, {
    required: false,
  });
  if (!id || !title) return null;
  return {
    id,
    title,
    ...(entry === undefined ? {} : { entry }),
    ...(nav === undefined ? {} : { nav }),
    ...(settings === undefined ? {} : { settings }),
    ...(dashboard === undefined ? {} : { dashboard }),
    ...(settingsSchema.length === 0 ? {} : { settingsSchema }),
    ...(settingsContributions.length === 0
      ? {}
      : { settingsContributions }),
    ...(dashboardContributions.length === 0
      ? {}
      : { dashboardContributions }),
    ...(apiRoutes.length === 0 ? {} : { apiRoutes }),
    ...(eventSubscriptions === undefined ? {} : { eventSubscriptions }),
  };
}

export function validateSolutionManifest(
  input: unknown,
): ValidationResult<SolutionManifestV1> {
  const issues: { path: string; message: string }[] = [];
  const obj = parseStrictObject(input, MANIFEST_KEYS, "$", issues);
  if (!obj) return fail(issues);

  if (obj.apiVersion !== "weflow.io/v1") {
    addIssue(issues, "$.apiVersion", 'must be "weflow.io/v1"');
  }
  if (obj.kind !== "Solution") {
    addIssue(issues, "$.kind", 'must be "Solution"');
  }

  const metadata = parseMetadata(obj.metadata, "$.metadata", issues);
  const compatibility = parseCompatibility(
    obj.compatibility,
    "$.compatibility",
    issues,
  );
  const dependencies = parseDependencies(
    obj.dependencies,
    "$.dependencies",
    issues,
  );

  const artifactsInput = obj.artifacts;
  const artifacts: SolutionArtifact[] = [];
  if (artifactsInput === undefined) {
    addIssue(issues, "$.artifacts", "field is required");
  } else if (!Array.isArray(artifactsInput)) {
    addIssue(issues, "$.artifacts", "expected an array");
  } else {
    artifactsInput.forEach((item, index) => {
      const artifact = parseArtifact(item, `$.artifacts[${index}]`, issues);
      if (artifact) artifacts.push(artifact);
    });
    hasUniqueIds(artifacts, "$.artifacts", issues);
  }

  const permissionsInput = obj.permissions;
  const permissions: SolutionPermission[] = [];
  if (permissionsInput === undefined) {
    addIssue(issues, "$.permissions", "field is required");
  } else if (!Array.isArray(permissionsInput)) {
    addIssue(issues, "$.permissions", "expected an array");
  } else {
    permissionsInput.forEach((item, index) => {
      const permission = parsePermission(item, `$.permissions[${index}]`, issues);
      if (permission) permissions.push(permission);
    });
    hasUniqueIds(permissions, "$.permissions", issues);
  }

  if (!isRecord(obj.configuration)) {
    addIssue(issues, "$.configuration", "expected an object");
  }
  const configuration = isRecord(obj.configuration) ? obj.configuration : {};

  const secretSlotsInput = obj.secretSlots;
  const secretSlots: SecretSlot[] = [];
  if (secretSlotsInput === undefined) {
    addIssue(issues, "$.secretSlots", "field is required");
  } else if (!Array.isArray(secretSlotsInput)) {
    addIssue(issues, "$.secretSlots", "expected an array");
  } else {
    secretSlotsInput.forEach((item, index) => {
      const slot = parseSecretSlot(item, `$.secretSlots[${index}]`, issues);
      if (slot) secretSlots.push(slot);
    });
    const secretNames = new Set<string>();
    secretSlots.forEach((slot, index) => {
      if (secretNames.has(slot.name)) {
        addIssue(
          issues,
          `$.secretSlots[${index}].name`,
          `duplicate secret slot "${slot.name}"`,
        );
      }
      secretNames.add(slot.name);
    });
  }

  const resourcesInput = obj.resources;
  const resources: SolutionResource[] = [];
  if (resourcesInput === undefined) {
    addIssue(issues, "$.resources", "field is required");
  } else if (!Array.isArray(resourcesInput)) {
    addIssue(issues, "$.resources", "expected an array");
  } else {
    resourcesInput.forEach((item, index) => {
      const resource = parseResource(item, `$.resources[${index}]`, issues);
      if (resource) resources.push(resource);
    });
    hasUniqueIds(resources, "$.resources", issues);
  }

  const executionProfilesInput = obj.executionProfiles;
  const executionProfiles: ExecutionProfile[] = [];
  if (executionProfilesInput === undefined) {
    addIssue(issues, "$.executionProfiles", "field is required");
  } else if (!Array.isArray(executionProfilesInput)) {
    addIssue(issues, "$.executionProfiles", "expected an array");
  } else {
    executionProfilesInput.forEach((item, index) => {
      const profile = parseExecutionProfile(
        item,
        `$.executionProfiles[${index}]`,
        issues,
      );
      if (profile) executionProfiles.push(profile);
    });
    hasUniqueIds(executionProfiles, "$.executionProfiles", issues);
  }

  const applicationsInput = obj.applications;
  const applications: SolutionApplication[] = [];
  if (applicationsInput === undefined) {
    addIssue(issues, "$.applications", "field is required");
  } else if (!Array.isArray(applicationsInput)) {
    addIssue(issues, "$.applications", "expected an array");
  } else {
    applicationsInput.forEach((item, index) => {
      const application = parseApplication(
        item,
        `$.applications[${index}]`,
        issues,
      );
      if (application) applications.push(application);
    });
    hasUniqueIds(applications, "$.applications", issues);
  }

  const consoleExtensionsInput = obj.consoleExtensions;
  const consoleExtensions: ConsoleExtension[] = [];
  if (consoleExtensionsInput !== undefined) {
    if (!Array.isArray(consoleExtensionsInput)) {
      addIssue(issues, "$.consoleExtensions", "expected an array");
    } else {
      consoleExtensionsInput.forEach((item, index) => {
        const extension = parseConsoleExtension(
          item,
          `$.consoleExtensions[${index}]`,
          issues,
        );
        if (extension) consoleExtensions.push(extension);
      });
      hasUniqueIds(consoleExtensions, "$.consoleExtensions", issues);
    }
  }

  const healthChecksInput = obj.healthChecks;
  const healthChecks: HealthCheck[] = [];
  if (healthChecksInput === undefined) {
    addIssue(issues, "$.healthChecks", "field is required");
  } else if (!Array.isArray(healthChecksInput)) {
    addIssue(issues, "$.healthChecks", "expected an array");
  } else {
    healthChecksInput.forEach((item, index) => {
      const healthCheck = parseHealthCheck(
        item,
        `$.healthChecks[${index}]`,
        issues,
      );
      if (healthCheck) healthChecks.push(healthCheck);
    });
    hasUniqueIds(healthChecks, "$.healthChecks", issues);
  }

  const backend =
    obj.backend === undefined
      ? undefined
      : (parseBackend(obj.backend, "$.backend", issues) ?? undefined);

  if (issues.length > 0) return fail(issues);
  if (
    !metadata ||
    !compatibility ||
    !dependencies ||
    !artifacts ||
    !permissions ||
    !secretSlots ||
    !resources ||
    !executionProfiles ||
    !applications ||
    !healthChecks
  ) {
    return fail(issues);
  }

  return ok({
    apiVersion: "weflow.io/v1",
    kind: "Solution",
    metadata,
    compatibility,
    dependencies,
    artifacts,
    permissions,
    configuration,
    secretSlots,
    resources,
    executionProfiles,
    applications,
    healthChecks,
    ...(backend === undefined ? {} : { backend }),
    ...(consoleExtensions.length === 0 ? {} : { consoleExtensions }),
  });
}
