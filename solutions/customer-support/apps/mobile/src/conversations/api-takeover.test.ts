import { beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "@/api/client";
import type { MobileSession } from "@/auth/session";
import { listTakeoverableConversations, takeOverHandoff } from "./api";

// vitest 会将 vi.mock 提升到所有 import 之上，因此可以放在 import 之后
vi.mock("@/api/client", () => ({
  request: vi.fn(),
}));

const session: MobileSession = {
  sessionToken: "test-token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  user: { userId: "agent-1", username: "leaif", mustChangePassword: false },
};

const mockedRequest = vi.mocked(request);

beforeEach(() => {
  mockedRequest.mockReset();
});

describe("listTakeoverableConversations（AGENT_ACTIVE 可接管列表）", () => {
  it("只保留无 handoff 行的活跃会话，过滤 resolved/他人处理中", async () => {
    mockedRequest.mockResolvedValue({
      conversations: [
        {
          conversationId: "wechat:agent-active-1",
          latestMessageAt: "2026-08-12T10:00:00.000Z",
          latestMessage: { text: "门锁完全不亮" },
          contact: { sharedAlias: "王先生" },
          handoff: null,
          unreadCustomerCount: 2,
        },
        {
          conversationId: "wechat:resolved-1",
          latestMessageAt: "2026-08-12T09:00:00.000Z",
          latestMessage: { text: "已解决" },
          contact: { channelContactId: "wxid_resolved" },
          handoff: { status: "resolved", agentPaused: false, assignedUserId: null },
        },
        {
          conversationId: "wechat:other-mine-1",
          latestMessageAt: "2026-08-12T08:00:00.000Z",
          latestMessage: { text: "他人处理中" },
          contact: { channelContactId: "wxid_other" },
          handoff: { status: "in_progress", agentPaused: true, assignedUserId: "agent-9" },
        },
      ],
    });

    const rows = await listTakeoverableConversations(session);

    expect(mockedRequest).toHaveBeenCalledWith(
      "/api/v1/conversations?scope=others&limit=50",
      { token: "test-token" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "wechat:agent-active-1",
      name: "王先生",
      preview: "门锁完全不亮",
      state: "agent",
      unread: 2,
    });
  });

  it("名称按 sharedAlias > channelDisplayName > channelRemark > channelNickname > ID 尾号回退", async () => {
    mockedRequest.mockResolvedValue({
      conversations: [
        {
          conversationId: "wechat:fallback-12345678",
          contact: {
            sharedAlias: null,
            channelDisplayName: null,
            channelRemark: null,
            channelNickname: null,
            channelContactId: "wxid_fallback_abc",
          },
          handoff: null,
        },
      ],
    });
    const [row] = await listTakeoverableConversations(session);
    expect(row?.name).toBe("客户 · back_abc");
  });
});

describe("takeOverHandoff（Manual Takeover）", () => {
  it("POST take-over 并携带幂等 clientRequestId", async () => {
    mockedRequest.mockResolvedValue({ replayed: false });
    const result = await takeOverHandoff(
      session,
      "wechat:agent-active-1",
      "request-id-1",
    );
    expect(mockedRequest).toHaveBeenCalledWith(
      "/api/v1/conversations/wechat%3Aagent-active-1/handoff/take-over",
      {
        method: "POST",
        token: "test-token",
        body: JSON.stringify({ clientRequestId: "request-id-1" }),
      },
    );
    expect(result.replayed).toBe(false);
  });

  it("幂等重放返回 replayed=true", async () => {
    mockedRequest.mockResolvedValue({ replayed: true });
    const result = await takeOverHandoff(session, "wechat:x", "same-id");
    expect(result.replayed).toBe(true);
  });
});
