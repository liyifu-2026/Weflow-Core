/**
 * 消息发送安全策略测试
 * 验证草稿过期判断和重试权限逻辑。
 */
import { describe, expect, it } from "vitest";
import { mayRetrySend, shouldMarkDraftStale } from "./safety";

describe("draft revision safety", () => {
  it("marks a draft stale when the conversation advanced after it was saved", () => {
    expect(shouldMarkDraftStale(4, 4, 5)).toBe(true);
  });

  it("does not mark a draft stale after the latest revision was reviewed", () => {
    expect(shouldMarkDraftStale(4, 5, 5)).toBe(false);
  });
});

describe("send outcome safety", () => {
  it("never retries an unknown outcome without a failed lookup", () => {
    expect(mayRetrySend("outcome_unknown", undefined)).toBe(false);
    expect(mayRetrySend("outcome_unknown", "pending")).toBe(false);
    expect(mayRetrySend("outcome_unknown", "not_found")).toBe(true);
  });

  it("never retries a permission loss or rejected send", () => {
    expect(mayRetrySend("permission_lost", "failed")).toBe(false);
    expect(mayRetrySend("rejected", "failed")).toBe(false);
  });
});
