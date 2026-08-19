import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSolutionLock } from "../src/lock.js";
import { sampleLock } from "./fixtures.js";

describe("validateSolutionLock", () => {
  it("accepts a valid lock", () => {
    const result = validateSolutionLock(sampleLock);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.solutionId, "weflow.customer-support");
    }
  });

  it("rejects unknown fields", () => {
    const result = validateSolutionLock({
      ...sampleLock,
      floatingTag: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.path === "$.floatingTag"),
        true,
      );
    }
  });

  it("rejects invalid digest format", () => {
    const result = validateSolutionLock({
      ...sampleLock,
      manifestDigest: "sha256:not-a-valid-digest",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.path === "$.manifestDigest"),
        true,
      );
    }
  });

  it("rejects duplicate locked artifact ids", () => {
    const result = validateSolutionLock({
      ...sampleLock,
      artifacts: [sampleLock.artifacts[0], sampleLock.artifacts[0]],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.issues.some((issue) => issue.message.includes("duplicate id")),
        true,
      );
    }
  });
});
