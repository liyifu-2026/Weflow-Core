import { describe, expect, it } from "vitest";
import {
  classifyError,
  isTerminal,
  normalizeStatus,
} from "../modules/agent/application/turn-utils.js";

describe("turn-utils isTerminal", () => {
  it("终态判定为 true", () => {
    for (const status of [
      "completed",
      "failed",
      "superseded",
      "suppressed_policy",
      "suppressed_handoff",
    ]) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it("非终态判定为 false", () => {
    for (const status of ["queued", "tool_planned", "running", "unknown", "whatever"]) {
      expect(isTerminal(status)).toBe(false);
    }
  });
});

describe("turn-utils normalizeStatus", () => {
  it("已知状态原样返回", () => {
    for (const status of [
      "completed",
      "failed",
      "superseded",
      "suppressed_policy",
      "suppressed_handoff",
      "queued",
      "tool_planned",
      "running",
    ]) {
      expect(normalizeStatus(status)).toBe(status);
    }
  });

  it("未知状态规范为 unknown（向前兼容）", () => {
    expect(normalizeStatus("some_future_state")).toBe("unknown");
  });
});

describe("turn-utils classifyError", () => {
  it("超时错误分类为 model_timeout", () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    expect(classifyError(error)).toBe("model_timeout");
  });

  it("其他错误分类为 model_request_failed", () => {
    expect(classifyError(new Error("boom"))).toBe("model_request_failed");
    expect(classifyError("string error")).toBe("model_request_failed");
    expect(classifyError(undefined)).toBe("model_request_failed");
  });
});
