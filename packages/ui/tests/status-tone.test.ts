import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusTone, validationTone } from "../src/status-tone.js";

describe("statusTone", () => {
  it("maps positive states to good", () => {
    assert.equal(statusTone("active"), "good");
    assert.equal(statusTone("healthy"), "good");
    assert.equal(statusTone("completed"), "good");
  });

  it("maps warning states to warn", () => {
    assert.equal(statusTone("queued"), "warn");
    assert.equal(statusTone("running"), "warn");
    assert.equal(statusTone("degraded"), "warn");
  });

  it("maps danger states to bad", () => {
    assert.equal(statusTone("failed"), "bad");
    assert.equal(statusTone("unreachable"), "bad");
  });

  it("falls back to neutral for unknown states", () => {
    assert.equal(statusTone("whatever"), "neutral");
    assert.equal(statusTone(null), "neutral");
  });
});

describe("validationTone", () => {
  it("returns warn for queued/running", () => {
    assert.equal(validationTone({ status: "queued" }), "warn");
    assert.equal(validationTone({ status: "running" }), "warn");
  });

  it("returns good/bad for completed by passed flag", () => {
    assert.equal(validationTone({ status: "completed", passed: true }), "good");
    assert.equal(validationTone({ status: "completed", passed: false }), "bad");
  });
});
