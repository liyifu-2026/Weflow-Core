import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentDisplayName,
  healthLabel,
  reasonLabel,
  stateLabel,
} from "../src/labels.js";

describe("labels", () => {
  it("maps state labels", () => {
    assert.equal(stateLabel("completed"), "已解析");
    assert.equal(stateLabel("unknown-state"), "unknown-state");
  });

  it("maps health labels", () => {
    assert.deepEqual(healthLabel("healthy"), { text: "正常", tone: "good" });
    assert.deepEqual(healthLabel("degraded"), { text: "降级", tone: "warn" });
    assert.deepEqual(healthLabel(null), { text: "未监测", tone: "inactive" });
  });

  it("maps handoff reason prefixes", () => {
    assert.equal(
      reasonLabel("agent_recommended: device_troubleshooting"),
      "Agent 建议人工处理",
    );
    assert.equal(reasonLabel("free form reason"), "free form reason");
  });

  it("maps agent display name", () => {
    assert.equal(agentDisplayName({ username: "alice" }), "alice");
    assert.equal(
      agentDisplayName({ username: "alice", displayName: "Alice" }),
      "Alice",
    );
    assert.equal(agentDisplayName(null), "值班操作员");
  });
});
