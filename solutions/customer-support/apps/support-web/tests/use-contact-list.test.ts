import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

const apiMock = vi.fn();
vi.mock("../src/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

import { useContactList } from "../src/composables/use-contact-list";

function contactRow(id: string) {
  return {
    contactId: id,
    conversationId: `conv-${id}`,
    channelDisplayName: null,
    channelNickname: id,
    channelRemark: null,
    sharedAlias: null,
    avatarUrl: null,
    latestMessageAt: null,
    latestMessageText: "",
    agentEnabled: true,
    blocked: false,
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

describe("useContactList", () => {
  it("首次加载：不带 q 时只带 limit，整表替换", async () => {
    apiMock.mockResolvedValue({ contacts: [contactRow("a")], nextCursor: "c1" });
    const list = useContactList({ getQuery: () => "" });
    await list.load(false);
    expect(apiMock).toHaveBeenCalledTimes(1);
    const url = apiMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/contacts?");
    expect(url).toContain("limit=50");
    expect(url).not.toContain("q=");
    expect(list.contacts.value.map((c) => c.contactId)).toEqual(["a"]);
    expect(list.nextCursor.value).toBe("c1");
  });

  it("搜索词进入 q 参数", async () => {
    apiMock.mockResolvedValue({ contacts: [], nextCursor: null });
    const list = useContactList({ getQuery: () => "  设备  " });
    await list.load(false);
    expect(apiMock.mock.calls[0][0] as string).toContain("q=%E8%AE%BE%E5%A4%87");
  });

  it("getFilter 的条件进入 agentEnabled / blocked 参数", async () => {
    apiMock.mockResolvedValue({ contacts: [], nextCursor: null });
    const list = useContactList({
      getQuery: () => "",
      getFilter: () => ({ blocked: true }),
    });
    await list.load(false);
    const url = apiMock.mock.calls[0][0] as string;
    expect(url).toContain("blocked=true");
    expect(url).not.toContain("agentEnabled");
  });

  it("续页追加 + contactId 去重 + 游标更新", async () => {
    apiMock
      .mockResolvedValueOnce({ contacts: [contactRow("a"), contactRow("b")], nextCursor: "c2" })
      .mockResolvedValueOnce({ contacts: [contactRow("b"), contactRow("c")], nextCursor: null });
    const list = useContactList({ getQuery: () => "" });
    await list.load(false);
    await list.load(true);
    expect(apiMock.mock.calls[1][0] as string).toContain("before=c2");
    expect(list.contacts.value.map((c) => c.contactId)).toEqual(["a", "b", "c"]);
    expect(list.nextCursor.value).toBeNull();
  });

  it("加载失败：error 置为消息，loading 复位", async () => {
    apiMock.mockRejectedValue(new Error("boom"));
    const list = useContactList({ getQuery: () => "" });
    await list.load(false);
    await nextTick();
    expect(list.error.value).toBe("boom");
    expect(list.loading.value).toBe(false);
  });

  it("非 Error 异常回落默认文案", async () => {
    apiMock.mockRejectedValue("nope");
    const list = useContactList({ getQuery: () => "" });
    await list.load(true);
    expect(list.error.value).toBe("联系人加载失败");
  });

  it("同方向加载进行中不重入；clear 清空全部", async () => {
    let resolveLoading!: (v: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((resolve) => (resolveLoading = resolve)));
    const list = useContactList({ getQuery: () => "" });
    const first = list.load(false);
    await list.load(false);
    expect(apiMock).toHaveBeenCalledTimes(1);
    resolveLoading({ contacts: [], nextCursor: null });
    await first;
    list.clear();
    expect(list.contacts.value).toHaveLength(0);
    expect(list.nextCursor.value).toBeNull();
    expect(list.error.value).toBe("");
  });
});
