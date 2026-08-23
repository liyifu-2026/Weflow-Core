import { describe, expect, it } from "vitest";
import {
  HumanOutput,
  JsonOutput,
  QuietOutput,
  createCliOutput,
  renderCommandResult,
  type WritableLike,
} from "../../tooling/weflowctl/src/cli-output.js";

function capture(): { out: WritableLike; text: () => string } {
  const chunks: string[] = [];
  return {
    out: { write: (chunk: string) => void chunks.push(chunk) },
    text: () => chunks.join(""),
  };
}

describe("HumanOutput", () => {
  it("writes colourised info/success/warn to stdout without color when disabled", () => {
    const { out, text } = capture();
    const output = new HumanOutput({ stream: out, color: false });
    output.info("plain info");
    output.success("done well");
    output.warn("careful");
    const rendered = text();
    expect(rendered).toContain("plain info");
    expect(rendered).toContain("✔ done well");
    expect(rendered).toContain("! careful");
    expect(rendered).not.toContain("\x1b[");
  });

  it("adds ANSI colours when enabled", () => {
    const { out, text } = capture();
    const output = new HumanOutput({ stream: out, color: true });
    output.success("ok");
    expect(text()).toContain("\x1b[32m");
  });

  it("renders aligned tables from row objects", () => {
    const { out, text } = capture();
    const output = new HumanOutput({ stream: out, color: false });
    output.table([
      { solutionId: "weflow.demo", activeVersion: "1.0.0" },
      { solutionId: "weflow.other", activeVersion: null },
    ]);
    const lines = text().split("\n").filter(Boolean);
    const [header, separator, firstRow, secondRow] = lines;
    if (!header || !separator || !firstRow || !secondRow) {
      throw new Error("table output incomplete");
    }
    expect(header).toContain("SOLUTIONID");
    expect(separator).toMatch(/^-/);
    // Column alignment: both data lines share the separator's total width.
    expect(firstRow.length).toBe(secondRow.length);
    expect(firstRow).toContain("weflow.demo");
    expect(secondRow).toContain("-"); // null renders as dash
  });

  it("routes errors with code and hint to stderr", () => {
    const errStream = capture();
    const output = new HumanOutput({
      stream: { write: () => undefined },
      errorStream: errStream.out,
      color: false,
    });
    output.error({
      code: "solution_signature_invalid",
      message: "signature mismatch",
      hint: "re-publish",
    });
    const rendered = errStream.text();
    expect(rendered).toContain(
      "✗ [solution_signature_invalid] signature mismatch",
    );
    expect(rendered).toContain("hint: re-publish");
  });

  it("prints pretty json on demand", () => {
    const { out, text } = capture();
    const output = new HumanOutput({ stream: out, color: false });
    output.json({ a: 1 });
    expect(JSON.parse(text())).toEqual({ a: 1 });
  });
});

describe("JsonOutput", () => {
  it("emits only structured json, one document per call", () => {
    const { out, text } = capture();
    const output = new JsonOutput(out);
    output.info("noise");
    output.table([{ a: 1 }]);
    output.json({ result: "value" });
    expect(text().trim()).toBe('{"result":"value"}');
  });

  it("writes errors as json objects", () => {
    const errStream = capture();
    const output = new JsonOutput({ write: () => undefined }, errStream.out);
    output.error({ code: "x_code", message: "boom" });
    expect(JSON.parse(errStream.text())).toEqual({
      error: { code: "x_code", message: "boom" },
    });
  });
});

describe("QuietOutput", () => {
  it("silences everything except errors", () => {
    const out = capture();
    const err = capture();
    const output = new QuietOutput(out.out, err.out);
    output.info("no");
    output.success("no");
    output.warn("no");
    output.json({ no: true });
    output.error({ message: "yes" });
    expect(out.text()).toBe("");
    expect(err.text()).toContain("yes");
  });
});

describe("createCliOutput", () => {
  it("selects implementation by flags", () => {
    expect(createCliOutput({ json: true })).toBeInstanceOf(JsonOutput);
    expect(createCliOutput({ quiet: true })).toBeInstanceOf(QuietOutput);
    expect(
      createCliOutput({}) instanceof HumanOutput ||
        createCliOutput({}) instanceof JsonOutput,
    ).toBe(true);
  });
});

describe("renderCommandResult", () => {
  function humanCapture() {
    const out = capture();
    const err = capture();
    const output = new HumanOutput({
      stream: out.out,
      errorStream: err.out,
      color: false,
    });
    return { out, err, output };
  }

  it("prints a success summary line for publish", () => {
    const { out, output } = humanCapture();
    renderCommandResult(
      "publish",
      {
        ok: true,
        data: {
          tgzPath: "/tmp/weflow.demo-1.0.0.tgz",
          solutionId: "weflow.demo",
          version: "1.0.0",
          manifestDigest: "sha256:aa",
        },
      },
      output,
      { json: false },
    );
    expect(out.text()).toContain("published weflow.demo@1.0.0");
  });

  it("renders list as a table in human mode", () => {
    const { out, output } = humanCapture();
    renderCommandResult(
      "list",
      {
        ok: true,
        data: {
          solutions: [
            {
              solutionId: "weflow.demo",
              installedVersions: ["1.0.0", "1.1.0"],
              activeVersion: "1.1.0",
            },
          ],
        },
      },
      output,
      { json: false },
    );
    expect(out.text()).toContain("weflow.demo");
    expect(out.text()).toContain("1.0.0, 1.1.0");
  });

  it("renders help text as plain info in human mode", () => {
    const { out, output } = humanCapture();
    renderCommandResult(
      "publish",
      { ok: true, data: { help: "Usage: weflowctl solution publish ..." } },
      output,
      { json: false },
    );
    expect(out.text()).toContain("Usage: weflowctl solution publish");
  });

  it("emits raw data untouched in json mode", () => {
    const { out, output } = humanCapture();
    renderCommandResult("list", { ok: true, data: { solutions: [] } }, output, {
      json: true,
    });
    expect(JSON.parse(out.text())).toEqual({ solutions: [] });
  });

  it("routes failures to error output with code and hint", () => {
    const { err, output } = humanCapture();
    renderCommandResult(
      "update",
      {
        ok: false,
        error: "invalid_update_strategy:weekly:expected manual|patch",
        code: "invalid_update_strategy",
        hint: "Use one of: manual, patch, minor, major.",
      },
      output,
      { json: false },
    );
    expect(err.text()).toContain("[invalid_update_strategy]");
    expect(err.text()).toContain("hint:");
  });
});
