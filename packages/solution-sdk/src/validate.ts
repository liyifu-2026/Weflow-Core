export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail(issues: ValidationIssue[]): ValidationResult<never> {
  return { ok: false, issues };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function addIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

/**
 * 严格对象解析：非对象或出现未知字段时直接记录问题。
 * 返回 null 表示调用方应停止继续解析该对象。
 */
export function parseStrictObject(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): Record<string, unknown> | null {
  if (!isRecord(input)) {
    addIssue(issues, path, "expected an object");
    return null;
  }
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, `${path}.${key}`, `unknown field "${key}"`);
    }
  }
  return input;
}

export function readString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { required?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const { required = true, allowEmpty = false } = options;
  const value = obj[key];
  if (value === undefined) {
    if (required) {
      addIssue(issues, `${path}.${key}`, "field is required");
    }
    return undefined;
  }
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    addIssue(
      issues,
      `${path}.${key}`,
      typeof value === "string" ? "must not be empty" : "expected a string",
    );
    return undefined;
  }
  return value;
}

export function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    addIssue(
      issues,
      `${path}.${key}`,
      typeof value === "string" ? "must not be empty" : "expected a string",
    );
    return undefined;
  }
  return value;
}

export function readBoolean(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  required = true,
): boolean | undefined {
  const value = obj[key];
  if (value === undefined) {
    if (required) {
      addIssue(issues, `${path}.${key}`, "field is required");
    }
    return undefined;
  }
  if (typeof value !== "boolean") {
    addIssue(issues, `${path}.${key}`, "expected a boolean");
    return undefined;
  }
  return value;
}

export function readNumber(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { required?: boolean; integer?: boolean; min?: number } = {},
): number | undefined {
  const { required = true, integer = false, min } = options;
  const value = obj[key];
  if (value === undefined) {
    if (required) {
      addIssue(issues, `${path}.${key}`, "field is required");
    }
    return undefined;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    addIssue(issues, `${path}.${key}`, "expected a number");
    return undefined;
  }
  if (integer && !Number.isInteger(value)) {
    addIssue(issues, `${path}.${key}`, "expected an integer");
    return undefined;
  }
  if (min !== undefined && value < min) {
    addIssue(issues, `${path}.${key}`, `must be >= ${min}`);
    return undefined;
  }
  return value;
}

export function readStringArray(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  issues: ValidationIssue[],
  options: { required?: boolean; unique?: boolean } = {},
): string[] {
  const { required = true, unique = false } = options;
  const value = obj[key];
  if (value === undefined) {
    if (required) {
      addIssue(issues, `${path}.${key}`, "field is required");
    }
    return [];
  }
  if (!Array.isArray(value)) {
    addIssue(issues, `${path}.${key}`, "expected an array");
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      addIssue(issues, `${path}.${key}[${index}]`, "expected a non-empty string");
      return;
    }
    if (unique && seen.has(item)) {
      addIssue(issues, `${path}.${key}[${index}]`, `duplicate value "${item}"`);
      return;
    }
    if (unique) seen.add(item);
    result.push(item);
  });
  return result;
}

export function hasUniqueIds<T extends { id: string }>(
  items: T[],
  path: string,
  issues: ValidationIssue[],
): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      addIssue(issues, `${path}[${index}].id`, `duplicate id "${item.id}"`);
    }
    seen.add(item.id);
  });
}

export function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
