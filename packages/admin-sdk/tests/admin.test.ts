import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSolutionOperation,
  parseSolutionSummary,
} from "../src/validation.js";

describe("admin-sdk runtime validation", () => {
  it("parses a valid solution summary", () => {
    const summary = parseSolutionSummary({
      solutionId: "example.platform",
      version: "1.0.0",
      name: "Customer Support Solution",
      publisher: "weflow",
      desiredState: "disabled",
      observedState: "installed",
      healthState: "unknown",
    });
    assert.equal(summary.solutionId, "example.platform");
    assert.equal(summary.observedState, "installed");
  });

  it("rejects an invalid observed state", () => {
    assert.throws(() =>
      parseSolutionSummary({
        solutionId: "example.platform",
        version: "1.0.0",
        name: "Customer Support Solution",
        publisher: "weflow",
        desiredState: "disabled",
        observedState: "flying",
        healthState: "unknown",
      }),
    );
  });

  it("parses a valid operation", () => {
    const operation = parseSolutionOperation({
      operationId: "op-1",
      solutionId: "example.platform",
      type: "install",
      state: "queued",
      idempotencyKey: "key-1",
      attempt: 1,
      actor: "admin@example.com",
    });
    assert.equal(operation.operationId, "op-1");
    assert.equal(operation.state, "queued");
  });

  it("rejects an operation missing actor", () => {
    assert.throws(() =>
      parseSolutionOperation({
        operationId: "op-1",
        solutionId: "example.platform",
        type: "install",
        state: "queued",
        idempotencyKey: "key-1",
        attempt: 1,
      }),
    );
  });
});
