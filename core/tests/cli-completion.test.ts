import { describe, expect, it } from "vitest";
import { completionFor } from "../../tooling/weflowctl/src/cli-completion.js";

describe("shell completion generation", () => {
  it("generates bash completion wiring the dev commands", () => {
    const script = completionFor("bash");
    expect(script).toContain("complete -F _weflowctl_completions weflowctl");
    expect(script).toContain("doctor");
    expect(script).toContain("down");
  });

  it("generates zsh completion with the command list", () => {
    const script = completionFor("zsh");
    expect(script).toContain("#compdef weflowctl");
    expect(script).toContain("'doctor'");
  });

  it("generates powershell completion via Register-ArgumentCompleter", () => {
    const script = completionFor("powershell");
    expect(script).toContain("Register-ArgumentCompleter");
    expect(script).toContain("'dev'");
  });

  it("rejects unknown shells with a stable error", () => {
    expect(() => completionFor("fish")).toThrow(
      "unknown_shell:fish:expected bash|zsh|powershell",
    );
  });
});
