/**
 * 会话操作控制器（Conversation Actions）。
 *
 * 全部写操作：人工接管三态（accept / take-over / resolve）、转交（客服/
 * 专业队列）与拒绝转交、回复发送与失败重试（clientRequestId 幂等）、
 * unknown 消息结果查证、媒体/素材上传发送、拍一拍、@提及解析、
 * 回复引用目标。状态反馈走 selection.detailError 与 toolHint。
 */
import { ref, type Ref } from "vue";
import { confirmDialog } from "../components/confirm-dialog";
import { api } from "../api";
import type { Message } from "../components/conversations/types";
import type { AssetItem } from "../assets/api";
import type { UseConversationSelection } from "./use-conversation-selection";

export type UseConversationActions = ReturnType<typeof useConversationActions>;

export function useConversationActions(options: {
  selection: UseConversationSelection;
  reloadList: () => Promise<void> | void;
  /** 草稿（工作区 store 会话字段） */
  replyText: Ref<string>;
  canReply: () => boolean;
  getMentionSources: () => Array<{ id: string; name: string }>;
  // 转交弹窗拉到客服列表后写入（Inspector 持有该状态，@提及共用）
  writeAssignees: (users: any[]) => void;
}) {
  const { selection } = options;

  const sending = ref(false);
  const retryBusy = ref(false);
  const actionBusy = ref(false);
  const mediaUploading = ref(false);
  // 接管转场：成功瞬间置 true 触发 180ms 状态转场（Composer/接管条 fade+slide）
  const takeoverTransition = ref(false);

  const detailError = selection.detailError;

  const toolHint = ref("");
  let toolHintTimer: ReturnType<typeof setTimeout> | undefined;
  function showToolHint(msg: string) {
    toolHint.value = msg;
    if (toolHintTimer) clearTimeout(toolHintTimer);
    toolHintTimer = setTimeout(() => (toolHint.value = ""), 2400);
  }

  // ---------- 人工处理三态 ----------
  async function transition(kind: "accept" | "take-over" | "resolve"): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    if (
      kind === "resolve" &&
      !await confirmDialog(
        "结束人工处理？\n\n后续客户再次发消息时，Agent 将重新负责。",
      )
    )
      return;
    actionBusy.value = true;
    try {
      await api(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/${kind}`,
        {
          method: "POST",
          body: JSON.stringify({
            // Manual Takeover 不要求原因（takeoverReason 可选）；resolve 保留既有话术
            ...(kind === "resolve"
              ? { summary: "桌面客服已完成处理" }
              : kind === "accept"
                ? { summary: "桌面客服接手" }
                : {}),
            clientRequestId: crypto.randomUUID(),
          }),
        },
      );
      if (kind === "take-over") {
        // 接管仪式：不整页重载——静默刷归属状态 + 列表，Composer 由转场动画淡入
        takeoverTransition.value = true;
        window.setTimeout(() => (takeoverTransition.value = false), 240);
        await Promise.all([selection.refreshContextSilently(), options.reloadList()]);
      } else {
        await Promise.all([selection.select(conversationId), options.reloadList()]);
      }
    } catch (reason) {
      if (kind === "take-over" && (reason as { status?: number })?.status === 409) {
        // 竞争失败是正常结果（§27）：静默刷新为「王工正在处理」只读，不弹错误
        await Promise.all([selection.refreshContextSilently(), options.reloadList()]);
        return;
      }
      detailError.value =
        reason instanceof Error ? reason.message : "接管操作失败";
    } finally {
      actionBusy.value = false;
    }
  }

  // 转交：两种责任转移（转客服 → 等待接受；转专业队列 → 释放进队列）。
  // 状态全部来自 Core handoff.state，前端不模拟“转交成功”。
  const transferOpen = ref(false);
  const transferTarget = ref("");
  const transferTargetType = ref<"user" | "queue">("user");
  const transferReason = ref("");
  const transferQueues = ref<Array<{ queueId: string; displayName: string }>>([]);

  function dismissTransfer(): void {
    transferOpen.value = false;
  }

  async function openTransfer(): Promise<void> {
    transferOpen.value = true;
    transferTarget.value = "";
    transferTargetType.value = "user";
    transferReason.value = "";
    try {
      const [assigneeResult, queueResult] = await Promise.all([
        api<{
          users: Array<{ userId: string; username: string; displayName?: string | null }>;
        }>("/api/v1/handoff-assignees"),
        api<{
          queues: Array<{ queueId: string; displayName: string; canReceiveHandoff?: boolean }>;
        }>("/api/v1/handoff-targets/queues").catch(() => ({ queues: [] })),
      ]);
      options.writeAssignees(assigneeResult.users);
      transferQueues.value = (queueResult.queues ?? []).filter(
        (queue) => queue.canReceiveHandoff !== false,
      );
    } catch {
      // 目标列表失败时保持旧客服列表
    }
  }

  // assignees 由 Inspector 持有（转交与 @提及共用）；经 options.writeAssignees 写入。

  async function doTransfer(): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId || !transferTarget.value) return;
    if (!transferReason.value.trim()) {
      detailError.value = "请填写转交原因";
      return;
    }
    transferOpen.value = false;
    actionBusy.value = true;
    try {
      await api(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/transfer`,
        {
          method: "POST",
          body: JSON.stringify({
            targetType: transferTargetType.value,
            targetId: transferTarget.value,
            transferReason: transferReason.value.trim(),
            sourceConversationRevision: selection.conversationRevision.value,
            expectedHandoffRevision: selection.handoff.value?.state?.handoffRevision ?? 0,
            clientRequestId: crypto.randomUUID(),
          }),
        },
      );
      transferTarget.value = "";
      transferReason.value = "";
      await selection.select(conversationId);
    } catch (reason) {
      detailError.value = reason instanceof Error ? reason.message : "转交失败";
    } finally {
      actionBusy.value = false;
    }
  }

  async function rejectIncomingTransfer(): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    if (!await confirmDialog("拒绝这次转交？会话将保持当前处理状态。")) return;
    actionBusy.value = true;
    try {
      await api(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/handoff/reject-transfer`,
        {
          method: "POST",
          body: JSON.stringify({
            expectedHandoffRevision: selection.handoff.value?.state?.handoffRevision ?? 0,
            clientRequestId: crypto.randomUUID(),
          }),
        },
      );
      await selection.select(conversationId);
    } catch (reason) {
      detailError.value = reason instanceof Error ? reason.message : "拒绝失败";
    } finally {
      actionBusy.value = false;
    }
  }

  // ---------- 发送 / 重试 / 结果查证 ----------
  // 发送恢复：failed → 重试（幂等复用 clientRequestId）；
  // unknown → 自动查询一次 outcome，仍未知才显示「查询结果」，期间禁止重发。
  const clientRequestMap = ref<Record<string, string>>({});
  const outcomeChecked = ref<Set<string>>(new Set());
  const outcomeBusy = ref(false);

  // --- 引用回复 ---
  const replyTarget = ref<Message | null>(null);
  function setReplyTarget(message: Message) {
    replyTarget.value = message;
  }
  function clearReplyTarget() {
    replyTarget.value = null;
  }

  /** 从当前 replyText 中提取 mentionContactRefs（@名字列表） */
  function extractMentionRefs(): string[] {
    const text = options.replyText.value;
    const refs: string[] = [];
    const regex = /@(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const name = m[1];
      // 尝试匹配联系人或客服名
      const found = options.getMentionSources().find((c) => c.name === name);
      if (found) refs.push(found.id);
    }
    return refs;
  }

  async function postMessage(text: string, clientRequestId: string, extra?: {
    mediaId?: string;
    media?: { fileId: string; kind: string };
    assetId?: string;
    replyToChannelMessageId?: string;
    mentionContactRefs?: string[];
  }): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    const body: Record<string, any> = { text, clientRequestId };
    if (extra?.mediaId) body.mediaId = extra.mediaId;
    if (extra?.media) body.media = extra.media;
    if (extra?.assetId) body.assetId = extra.assetId;
    if (extra?.replyToChannelMessageId) body.replyToChannelMessageId = extra.replyToChannelMessageId;
    if (extra?.mentionContactRefs?.length) body.mentionContactRefs = extra.mentionContactRefs;
    await api(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async function send(): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!options.canReply() || !conversationId || sending.value) return;
    sending.value = true;
    const text = options.replyText.value.trim();
    try {
      const mentionRefs = extractMentionRefs();
      await postMessage(text, crypto.randomUUID(), {
        replyToChannelMessageId: replyTarget.value?.messageId || undefined,
        mentionContactRefs: mentionRefs.length ? mentionRefs : undefined,
      });
      options.replyText.value = "";
      clearReplyTarget();
      await Promise.all([selection.select(conversationId), options.reloadList()]);
    } catch (reason) {
      detailError.value =
        reason instanceof Error ? reason.message : "回复未能发送";
    } finally {
      sending.value = false;
    }
  }

  async function retryMessage(message: Message): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId || retryBusy.value) return;
    retryBusy.value = true;
    try {
      // unknown = 通道侧无操作记录（如微信重启使 GUI 会话失效），同 key
      // 幂等只会命中旧消息，必须换新 clientRequestId 才能真正补发
      const clientRequestId =
        message.sendState === "unknown"
          ? crypto.randomUUID()
          : (clientRequestMap.value[message.messageId] ?? crypto.randomUUID());
      clientRequestMap.value[message.messageId] = clientRequestId;
      await postMessage(message.text || "", clientRequestId);
      await Promise.all([selection.select(conversationId), options.reloadList()]);
    } catch (reason) {
      detailError.value =
        reason instanceof Error ? reason.message : "重试失败";
    } finally {
      retryBusy.value = false;
    }
  }

  async function checkMessageOutcome(message: Message): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    outcomeBusy.value = true;
    try {
      const clientRequestId =
        clientRequestMap.value[message.messageId] ?? message.messageId;
      const result = await api<{
        status:
          | "pending"
          | "accepted"
          | "sent"
          | "failed"
          | "unknown"
          | "held"
          | "cancelled"
          | "not_found";
      }>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/outcome?clientRequestId=${encodeURIComponent(clientRequestId)}`,
      );
      outcomeChecked.value.add(message.messageId);
      if (result.status === "unknown") {
        // 通道侧没有该操作的记录（如 channel host / 微信重启后丢失），
        // 同 clientRequestId 的重试只会幂等命中旧消息，必须引导补发
        showToolHint("通道侧无发送记录，请点「重新发送」补发");
      } else if (result.status !== "not_found") {
        // 服务端已确认状态：刷新会话让 sendState 反映事实
        await selection.select(conversationId);
      }
    } catch {
      outcomeChecked.value.add(message.messageId);
    } finally {
      outcomeBusy.value = false;
    }
  }

  // 会话加载后：对 unknown 消息自动查询一次结果（不把责任丢给用户）
  async function autoCheckUnknownOutcomes(): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    for (const message of selection.messages.value) {
      if (
        message.sendState === "unknown" &&
        !outcomeChecked.value.has(message.messageId)
      ) {
        outcomeChecked.value.add(message.messageId);
        const clientRequestId =
          clientRequestMap.value[message.messageId] ?? message.messageId;
        try {
          const result = await api<{ status: string }>(
            `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/outcome?clientRequestId=${encodeURIComponent(clientRequestId)}`,
          );
          if (result.status !== "not_found") {
            await selection.select(conversationId);
            break;
          }
        } catch {
          // 查询失败保持 unknown，用户可手动查询
        }
      }
    }
  }

  // ---------- 媒体 / 素材发送 ----------
  async function uploadMedia(file: File, kind: "image" | "file"): Promise<{ mediaId: string; fileId: string } | null> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return null;
    mediaUploading.value = true;
    try {
      const fd = new FormData();
      fd.append("file", file);
      const result = await api<{ media: { mediaId: string; fileId: string } }>("/api/v1/media", {
        method: "POST",
        body: fd,
      });
      return result.media;
    } catch (reason) {
      showToolHint(reason instanceof Error ? reason.message : "上传失败");
      return null;
    } finally {
      mediaUploading.value = false;
    }
  }

  async function onImagePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const result = await uploadMedia(file, "image");
    if (!result) return;
    try {
      await postMessage("", crypto.randomUUID(), {
        mediaId: result.mediaId,
        media: { fileId: result.fileId, kind: "image" },
      });
      await Promise.all([selection.select(selection.selectedId.value), options.reloadList()]);
    } catch {
      showToolHint("图片发送失败");
    }
  }

  async function onFilePicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const result = await uploadMedia(file, "file");
    if (!result) return;
    try {
      await postMessage("", crypto.randomUUID(), {
        mediaId: result.mediaId,
        media: { fileId: result.fileId, kind: "file" },
      });
      await Promise.all([selection.select(selection.selectedId.value), options.reloadList()]);
    } catch {
      showToolHint("文件发送失败");
    }
  }

  async function sendAsset(asset: AssetItem, text = ""): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    mediaUploading.value = true;
    try {
      await postMessage(text, crypto.randomUUID(), { assetId: asset.assetId });
      await Promise.all([selection.select(conversationId), options.reloadList()]);
    } catch (reason) {
      showToolHint(reason instanceof Error ? reason.message : "素材发送失败");
    } finally {
      mediaUploading.value = false;
    }
  }

  /** 素材选择器结果（assetPickerOpen 的关闭由视图负责） */
  async function submitAssetPick(result: {
    type: "asset" | "file";
    asset?: AssetItem;
    file?: File;
    category?: "image" | "file";
  }): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    try {
      if (result.type === "asset" && result.asset) {
        await sendAsset(result.asset);
      } else if (result.file && result.category) {
        // 降级路径：入空间失败时直接按原有上传发送链路发送
        const uploaded = await uploadMedia(result.file, result.category);
        if (!uploaded) return;
        await postMessage("", crypto.randomUUID(), {
          mediaId: uploaded.mediaId,
          media: { fileId: uploaded.fileId, kind: result.category },
        });
        await Promise.all([selection.select(conversationId), options.reloadList()]);
      }
    } catch (reason) {
      showToolHint(reason instanceof Error ? reason.message : "发送失败");
    }
  }

  // --- 拍一拍 ---
  async function sendPoke(_message: Message): Promise<void> {
    const conversationId = selection.selectedId.value;
    if (!conversationId) return;
    try {
      await api(`/api/v1/conversations/${encodeURIComponent(conversationId)}/poke`, {
        method: "POST",
      });
      await Promise.all([selection.select(conversationId), options.reloadList()]);
    } catch {
      showToolHint("拍一拍发送失败");
    }
  }

  return {
    sending,
    retryBusy,
    actionBusy,
    mediaUploading,
    takeoverTransition,
    toolHint,
    transferOpen,
    transferTarget,
    transferTargetType,
    transferReason,
    transferQueues,
    clientRequestMap,
    outcomeBusy,
    replyTarget,
    showToolHint,
    transition,
    dismissTransfer,
    openTransfer,
    doTransfer,
    rejectIncomingTransfer,

    setReplyTarget,
    clearReplyTarget,
    extractMentionRefs,
    send,
    retryMessage,
    checkMessageOutcome,
    autoCheckUnknownOutcomes,
    uploadMedia,
    onImagePicked,
    onFilePicked,
    sendAsset,
    submitAssetPick,
    sendPoke,
  };
}
