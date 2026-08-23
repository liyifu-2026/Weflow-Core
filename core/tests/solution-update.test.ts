import { describe, expect, it } from "vitest";
import { resolveUpdateTarget } from "../infrastructure/solutions/solution-update.js";

describe("resolveUpdateTarget", () => {
  const candidates = ["1.0.0", "1.1.0", "1.1.5", "1.9.0", "2.0.0", "2.1.0"];

  it("picks the highest patch-level upgrade", () => {
    expect(
      resolveUpdateTarget({
        candidates,
        current: "1.1.0",
        strategy: "patch",
      }),
    ).toBe("1.1.5");
  });

  it("returns null when no patch-level candidate exists", () => {
    expect(
      resolveUpdateTarget({ candidates, current: "1.1.5", strategy: "patch" }),
    ).toBeNull();
  });

  it("picks the highest minor upgrade within the same major", () => {
    expect(
      resolveUpdateTarget({
        candidates,
        current: "1.1.0",
        strategy: "minor",
      }),
    ).toBe("1.9.0");
  });

  it("picks the highest major upgrade when allowed", () => {
    expect(
      resolveUpdateTarget({
        candidates,
        current: "1.1.0",
        strategy: "major",
      }),
    ).toBe("2.1.0");
  });

  it("manual requires an explicit version from the candidate set", () => {
    expect(
      resolveUpdateTarget({
        candidates,
        current: "1.1.0",
        strategy: "manual",
        explicitVersion: "1.9.0",
      }),
    ).toBe("1.9.0");
    expect(
      resolveUpdateTarget({
        candidates,
        current: "1.1.0",
        strategy: "manual",
        explicitVersion: "9.9.9",
      }),
    ).toBeNull();
    expect(
      resolveUpdateTarget({ candidates, current: "1.1.0", strategy: "manual" }),
    ).toBeNull();
  });

  it("never returns a downgrade or the current version", () => {
    expect(
      resolveUpdateTarget({
        candidates,
        current: "2.1.0",
        strategy: "major",
      }),
    ).toBeNull();
    expect(
      resolveUpdateTarget({
        candidates,
        current: "1.9.0",
        strategy: "minor",
        explicitVersion: "1.1.0",
      }),
    ).toBeNull();
  });

  it("ignores invalid candidate versions", () => {
    expect(
      resolveUpdateTarget({
        candidates: ["not-a-version", "1.2.0"],
        current: "1.1.0",
        strategy: "minor",
      }),
    ).toBe("1.2.0");
  });

  it("returns null when nothing is installed yet", () => {
    expect(
      resolveUpdateTarget({ candidates, current: null, strategy: "minor" }),
    ).toBeNull();
  });
});
