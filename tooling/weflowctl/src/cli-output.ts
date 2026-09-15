/**
 * CLI output abstraction.
 *
 * Command layers return structured results; the entry point renders them
 * through one of these implementations so the same command serves humans
 * (default), scripts (--json) and pipelines (--quiet).
 */
export interface WritableLike {
  write(chunk: string): void;
}

export interface CliErrorPayload {
  code?: string;
  message: string;
  hint?: string;
}

export interface CliOutput {
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(err: CliErrorPayload): void;
  table(rows: Array<Record<string, unknown>>): void;
  json(data: unknown): void;
}

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

function supportsColor(): boolean {
  return process.stdout.isTTY && !process.env.NO_COLOR;
}

export type HumanOutputOptions = {
  stream?: WritableLike;
  errorStream?: WritableLike;
  color?: boolean | undefined;
};

function defaultStdout(): WritableLike {
  return { write: (chunk: string) => process.stdout.write(chunk) };
}

function defaultStderr(): WritableLike {
  return { write: (chunk: string) => process.stderr.write(chunk) };
}

export class HumanOutput implements CliOutput {
  private readonly stream: WritableLike;
  private readonly errorStream: WritableLike;
  private readonly color: boolean;

  constructor(options: HumanOutputOptions = {}) {
    this.stream = options.stream ?? defaultStdout();
    this.errorStream = options.errorStream ?? defaultStderr();
    this.color = options.color ?? supportsColor();
  }

  info(message: string): void {
    this.stream.write(`${this.paint(message, DIM)}\n`);
  }

  success(message: string): void {
    this.stream.write(`${this.paint(`✔ ${message}`, GREEN)}\n`);
  }

  warn(message: string): void {
    this.stream.write(`${this.paint(`! ${message}`, YELLOW)}\n`);
  }

  error(err: CliErrorPayload): void {
    const codePrefix = err.code ? `[${err.code}] ` : "";
    this.errorStream.write(
      `${this.paint(`✗ ${codePrefix}${err.message}`, RED)}\n`,
    );
    if (err.hint) {
      this.errorStream.write(`${this.paint(`hint: ${err.hint}`, CYAN)}\n`);
    }
  }

  table(rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0) {
      this.stream.write(`${this.paint("(no rows)", DIM)}\n`);
      return;
    }
    const columns: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    const cell = (value: unknown): string => {
      if (value === null || value === undefined) return "-";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return JSON.stringify(value);
    };
    const widths = columns.map((column) =>
      Math.max(column.length, ...rows.map((row) => cell(row[column]).length)),
    );
    const line = (cells: string[]): string =>
      cells.map((text, index) => text.padEnd(widths[index] ?? 0)).join("  ");
    this.stream.write(
      `${this.paint(line(columns.map((column) => column.toUpperCase())), DIM)}\n`,
    );
    this.stream.write(`${line(widths.map((width) => "-".repeat(width)))}\n`);
    for (const row of rows) {
      this.stream.write(
        `${line(columns.map((column) => cell(row[column])))}\n`,
      );
    }
  }

  json(data: unknown): void {
    this.stream.write(`${JSON.stringify(data, null, 2)}\n`);
  }

  private paint(text: string, color: string): string {
    return this.color ? `${color}${text}${RESET}` : text;
  }
}

/** Machine mode: exactly one JSON document per json()/error() call. */
export class JsonOutput implements CliOutput {
  private readonly stream: WritableLike;
  private readonly errorStream: WritableLike;

  constructor(stream?: WritableLike, errorStream?: WritableLike) {
    this.stream = stream ?? defaultStdout();
    this.errorStream = errorStream ?? defaultStderr();
  }

  info(message: string): void {
    void message;
  }
  success(message: string): void {
    void message;
  }
  warn(message: string): void {
    void message;
  }
  table(rows: Array<Record<string, unknown>>): void {
    void rows;
  }

  json(data: unknown): void {
    this.stream.write(`${JSON.stringify(data)}\n`);
  }

  error(err: CliErrorPayload): void {
    this.errorStream.write(`${JSON.stringify({ error: err })}\n`);
  }
}

/** Pipeline mode: silence everything except errors. */
export class QuietOutput implements CliOutput {
  private readonly errorStream: WritableLike;

  constructor(_stream?: WritableLike, errorStream?: WritableLike) {
    void _stream;
    this.errorStream = errorStream ?? defaultStderr();
  }

  info(message: string): void {
    void message;
  }
  success(message: string): void {
    void message;
  }
  warn(message: string): void {
    void message;
  }
  table(rows: Array<Record<string, unknown>>): void {
    void rows;
  }
  json(data: unknown): void {
    void data;
  }

  error(err: CliErrorPayload): void {
    const codePrefix = err.code ? `[${err.code}] ` : "";
    this.errorStream.write(`✗ ${codePrefix}${err.message}\n`);
  }
}

export function createCliOutput(
  flags: { json?: boolean; quiet?: boolean },
  options: HumanOutputOptions = {},
): CliOutput {
  if (flags.quiet) return new QuietOutput(options.stream, options.errorStream);
  if (flags.json) {
    return new JsonOutput(options.stream, options.errorStream);
  }
  return new HumanOutput({
    ...options,
    ...(options.color !== undefined ? { color: options.color } : {}),
  });
}

type CommandOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; code?: string; hint?: string };

/**
 * Render a structured command outcome. Command layers only route failures
 * here (their success paths render tables/summaries themselves); in JSON mode
 * the raw data is emitted untouched.
 */
export function renderCommandResult(
  result: CommandOutcome,
  output: CliOutput,
  options: { json: boolean },
): void {
  if (!result.ok) {
    output.error({
      ...(result.code !== undefined ? { code: result.code } : {}),
      message: result.error,
      ...(result.hint !== undefined ? { hint: result.hint } : {}),
    });
    return;
  }
  const data = result.data;
  if (options.json) {
    output.json(data);
    return;
  }
  if (typeof data.help === "string" && Object.keys(data).length === 1) {
    output.info(data.help);
    return;
  }
  output.json(data);
}
