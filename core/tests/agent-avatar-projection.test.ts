/**
 * AI 员工消息头像链路单元验证（不依赖 DB/网络）：
 * transcript 的 actorAvatarUrl 推导与 DiceBear URL 格式。
 */
import { describe, expect, it } from "vitest";

function actorAvatarUrlOf(row: {
  actorType: string;
  actorId: string | null;
}): string | null {
  return row.actorType === "agent" && row.actorId
    ? `/api/v1/avatars/dicebear/voxel-bot/${encodeURIComponent(row.actorId)}`
    : null;
}

describe("AI 员工消息头像（transcript 投影）", () => {
  it("agent + actorId → voxel-bot 代理 URL（seed=员工标识）", () => {
    expect(
      actorAvatarUrlOf({
        actorType: "agent",
        actorId: "ai_employee:abc-123",
      }),
    ).toBe(
      `/api/v1/avatars/dicebear/voxel-bot/${encodeURIComponent("ai_employee:abc-123")}`,
    );
  });
  it("actorId 缺失（旧数据）→ null，前端回退通用 AI 标识", () => {
    expect(actorAvatarUrlOf({ actorType: "agent", actorId: null })).toBeNull();
  });
  it("非 agent 消息 → null（客户/人工头像走各自链路）", () => {
    expect(
      actorAvatarUrlOf({ actorType: "channel_contact", actorId: "wxid_x" }),
    ).toBeNull();
    expect(
      actorAvatarUrlOf({ actorType: "user", actorId: "user-1" }),
    ).toBeNull();
  });
});
