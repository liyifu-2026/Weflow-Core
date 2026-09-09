/**
 * 会话详情页面
 * 客服处理客户会话的核心页面，包含：
 * - 聊天记录展示（支持分页加载和实时刷新）
 * - 人工接管操作（接手、转交、结束人工处理）
 * - 手动回复（带本地草稿保存和发送状态追踪）
 * - 协作请求（向专业队列请求协助）
 * - 联系人资料查看和编辑
 * - 图片/语音消息查看与播放（仅在线，不缓存到本地）
 * - 拍一拍系统提示与表情包文本化展示
 * - 离线模式支持（查看缓存的文本记录）
 */
import { router, useLocalSearchParams } from "expo-router";
import * as Crypto from "expo-crypto";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { prepareImageForUpload } from "@/media/prepare-image";

import { ArrowDown } from "phosphor-react-native/src/icons/ArrowDown";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { ArrowUp } from "phosphor-react-native/src/icons/ArrowUp";


import { DotsThree } from "phosphor-react-native/src/icons/DotsThree";

import { Hand } from "phosphor-react-native/src/icons/Hand";



import { ArrowBendUpLeft as Reply } from "phosphor-react-native/src/icons/ArrowBendUpLeft";
import { UserCircle } from "phosphor-react-native/src/icons/UserCircle";

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, AppState, FlatList, KeyboardAvoidingView, Keyboard, Modal, Platform, Pressable, Text, Vibration, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LoadState } from "@/ui/load-state";
import { ApiError } from "@/api/client";
import { actionErrorCopy } from "@/api/action-error-copy";

import { loadSession, type MobileSession } from "@/auth/session";
import { acceptHandoff, getContactProfile, getHandoff, getManualReplyOutcome, getTranscript, getHandoffOperationOutcome, markConversationRead, rejectTransfer, sendManualReply, takeOverHandoff, pokeConversation, type HandoffDetail } from "@/conversations/api";
import { getMe } from "@/auth/api";
import { saveSession } from "@/auth/session";
import { TransferSheet } from "@/handoffs/transfer-sheet";
import { AssetPickerSheet } from "@/media/asset-picker-sheet";
import type { AssetItem } from "@/media/asset-api";
import { FinishHandoffSheet } from "@/handoffs/finish-sheet";
import { deleteDraft, loadDraft, loadLatestConversationDraft, saveDraft, type LocalDraft } from "@/conversations/draft-store";
import { canSendDraft, isDraftOwner, restoreDraftAfterSendFailure, restoredDraftForCycle } from "@/conversations/draft-lifecycle";
import { loadCachedTranscript, saveCachedTranscript } from "@/conversations/transcript-cache";
import { mayRetrySend, type SendFailureCode } from "@/conversations/safety";

import { countNewTimelineMessages, mergeTimelineMessages } from "@/conversations/timeline";
import { handoffBriefingViewModel, minimalHandoffBriefViewModel } from "@/conversations/handoff-briefing";
import { markBriefRead, wasBriefRead } from "@/conversations/brief-read-state";
import { HandoffBrief, type BriefMode } from "@/handoffs/brief-view";
import { ContactSheet } from "@/handoffs/contact-sheet";


import { formatDate, isSameDay } from "@/ui/format";

import { uploadMedia } from "@/media/api";

import { HandoffHistorySheet } from "@/handoffs/handoff-history-sheet";
import { deriveConversationUiState } from "@/conversations/ui-state";
import { useConversationList } from "@/conversations/use-conversation-list";
import { notifyConversationRefresh } from "@/conversations/sync-store";
import {
  REALTIME_REFRESH_DEBOUNCE_MS,
  subscribeConversationEvents,
} from "@/realtime/conversation-event-stream";


import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { useReducedMotion } from "@/ui/use-reduced-motion";

import { answerCollaborationRequest, cancelCollaborationRequest, closeCollaborationRequest, listConversationCollaboration, type CollaborationRequest } from "@/collaboration/api";

import { createStyles } from "@/conversation/styles";
import { type DisplayMessage, type SendFailure } from "@/conversation/types";
import { classifySendFailure, showActionError } from "@/conversation/screen-helpers";
import { TranscriptMessage } from "@/conversation/message-bubble";
import { ArchivedDraftPanel, ContactProfileModal, ConversationMenuModal } from "@/conversation/conversation-modals";
import { CollaborationResponseModal, CollaborationSummary } from "@/conversation/collaboration-ui";
import { Composer } from "@/conversation/composer";
import { ActionPanel } from "@/conversation/action-panel";

/** 结果未知消息的后台复查节奏：约 20s 内自动确认；超时后保留手动点击入口 */
const OUTCOME_RECHECK_INTERVAL_MS = 2_500;
const OUTCOME_RECHECK_MAX_ATTEMPTS = 8;

/** 会话详情页面组件 */
export default function ConversationScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { id, finish } = useLocalSearchParams<{ id: string; finish?: string }>();
  const { conversations, refresh: refreshConversations, capabilities } =
    useConversationList();
  const conversationPreview = conversations.find((item) => item.id === id);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const [unseenCount, setUnseenCount] = useState(0);
  const [conversationRevision, setConversationRevision] = useState<number>();
  const [session, setSession] = useState<MobileSession>();
  const [handoff, setHandoff] = useState<HandoffDetail>();
  const [handoffUnavailable, setHandoffUnavailable] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState<LocalDraft["status"]>();
  const [archivedDraftId, setArchivedDraftId] = useState<string>();
  const [draftFailure, setDraftFailure] = useState<SendFailure>();
  /** 结果未知的消息：后台自动复查落库结果，免去手动点气泡才能继续发送 */
  const [pendingOutcomeKey, setPendingOutcomeKey] = useState<string>();
  /** 发送期间的软提示（如「发送期间客户又发了新消息」），几秒后自动消失 */
  const [sendNotice, setSendNotice] = useState<string>();
  const sendNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [reviewedAtRevision, setReviewedAtRevision] = useState<number | null>(
    null,
  );
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [noteFocus, setNoteFocus] = useState(false);
  const [contactProfileOpen, setContactProfileOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [collaborations, setCollaborations] = useState<CollaborationRequest[]>(
    [],
  );
  const [responseRequest, setResponseRequest] =
    useState<CollaborationRequest>();
  const [responseText, setResponseText] = useState("");
  const [acting, setActing] = useState(false);
  const [responsibilityNotice, setResponsibilityNotice] = useState<string>();
  const [briefDefaultMode, setBriefDefaultMode] = useState<BriefMode>("compact");
  const [transcriptScrolled, setTranscriptScrolled] = useState(false);
  const composerAppear = useRef(new Animated.Value(0)).current;
  const [contactSheetOpen, setContactSheetOpen] = useState(false);
  const [handoffHistoryOpen, setHandoffHistoryOpen] = useState(false);
  // 联系人资料兜底数据源：会话列表预览缺失 contactId 时（如直接进入会话、
  // 列表尚未同步），用 contact-profile 接口补齐，保证对话内客户头像可用。
  const [profileContactId, setProfileContactId] = useState<string | null>(null);
  useEffect(() => {
    if (!session || !id) return;
    let disposed = false;
    void getContactProfile(session, id)
      .then((profile) => {
        if (!disposed && profile?.contactId) setProfileContactId(profile.contactId);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [session, id]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // 回复目标消息（长按消息气泡设置）
  const [replyTarget, setReplyTarget] = useState<DisplayMessage | null>(null);
  // 长按消息弹出的操作菜单
  const [messageMenu, setMessageMenu] = useState<{
    message: DisplayMessage;
  } | null>(null);
  // 媒体发送中状态
  const [mediaSending, setMediaSending] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  // 初始加载重试触发器（错误态「重新加载」时递增）
  const [reloadKey, setReloadKey] = useState(0);
  const [offline, setOffline] = useState(false);
  const [isActive, setIsActive] = useState(AppState.currentState === "active");
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef<number | undefined>(undefined);
  const draftRef = useRef("");
  const claimRequestIdRef = useRef<string | undefined>(undefined);
  const takeoverRequestIdRef = useRef<string | undefined>(undefined);
  const rejectRequestIdRef = useRef<string | undefined>(undefined);
  const messagesRef = useRef<DisplayMessage[]>([]);
  const handoffRef = useRef<HandoffDetail | undefined>(undefined);
  const scrollRef = useRef<FlatList<DisplayMessage>>(null);
  const atBottomRef = useRef(true);
  const shouldAutoFollowRef = useRef(true);
  const timelineReadyRef = useRef(false);
  const lastReadMessageIdRef = useRef<string | undefined>(undefined);
  // 数据就绪后兜底定位到最新：长列表分批渲染期间连续多次滚动，
  // 每次内容变长后再落底一次，确保最终到达最新消息
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (!loading || messages.length === 0 || initialScrollDoneRef.current)
      return undefined;
    initialScrollDoneRef.current = true;
    const scrollToEnd = () => scrollRef.current?.scrollToEnd({ animated: false });
    scrollToEnd();
    const timers = [
      setTimeout(scrollToEnd, 80),
      setTimeout(scrollToEnd, 240),
      setTimeout(scrollToEnd, 520),
    ];
    return () => timers.forEach(clearTimeout);
  }, [loading, messages.length]);
  // 切换会话（复用同一页面实例）时重置定位状态
  useEffect(() => {
    initialScrollDoneRef.current = false;
    timelineReadyRef.current = false;
    shouldAutoFollowRef.current = true;
  }, [id]);
  // 左滑「交回 Agent」入口：进入即打开结束人工处理面板
  useEffect(() => {
    if (finish !== "1" || !handoff || finishOpen) return undefined;
    const timer = setTimeout(() => setFinishOpen(true), 0);
    return () => clearTimeout(timer);
  }, [finish, handoff, finishOpen]);
  useEffect(() => {
    revisionRef.current = conversationRevision;
  }, [conversationRevision]);
  // 发送结果未知：后台自动复查（上限 8 次 / 约 20s），确认后自动解锁输入框。
  useEffect(() => {
    if (!session || !id || !pendingOutcomeKey) return undefined;
    const pending = messagesRef.current.find(
      (item) => item.clientRequestId === pendingOutcomeKey,
    );
    if (!pending) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (cancelled) return;
      attempts += 1;
      void checkUnknownOutcome(pending, { silent: true }).finally(() => {
        if (cancelled || attempts >= OUTCOME_RECHECK_MAX_ATTEMPTS) return;
        timer = setTimeout(tick, OUTCOME_RECHECK_INTERVAL_MS);
      });
    };
    timer = setTimeout(tick, OUTCOME_RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // checkUnknownOutcome 每次渲染都会重建，纳入依赖会让复查定时器永远重启；
    // 这里只按 pendingOutcomeKey 重排复查（session/id 变化时整体重挂）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOutcomeKey, id, session]);
  // 软提示定时器随组件卸载清理
  useEffect(
    () => () => {
      if (sendNoticeTimerRef.current) clearTimeout(sendNoticeTimerRef.current);
    },
    [],
  );
  /** 非阻塞软提示：不打断操作，4 秒后自动消失 */
  function showSendNotice(text: string) {
    setSendNotice(text);
    if (sendNoticeTimerRef.current) clearTimeout(sendNoticeTimerRef.current);
    sendNoticeTimerRef.current = setTimeout(
      () => setSendNotice(undefined),
      4_000,
    );
  }
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    handoffRef.current = handoff;
  }, [handoff]);
  // 初始化加载：获取聊天记录（优先在线，降级到离线缓存）、人工接管状态和协作请求
  useEffect(() => {
    if (!id) return;
    void (async () => {
      // 重试（reloadKey 变化）时重置加载态
      setLoading(true);
      setError(undefined);
      try {
        const session = await loadSession();
        if (!session) throw new Error("authentication_required");
        setSession(session);
        // 轻量刷新用户投影（头像/显示名在 Console 或名片页变更后同步），
        // 失败静默：本地缓存的会话仍可用。
        void getMe(session)
          .then((user) => {
            const updated = { ...session, user };
            setSession(updated);
            void saveSession(updated);
          })
          .catch(() => undefined);
        const [pageResult, handoffResult, collaborationResult] =
          await Promise.allSettled([
          getTranscript(session, id),
          getHandoff(session, id),
          listConversationCollaboration(session, id),
        ]);
        const cached =
          pageResult.status === "rejected"
            ? await loadCachedTranscript(session.user.userId, id)
            : undefined;
        const page =
          pageResult.status === "fulfilled" ? pageResult.value : cached;
        const restoredOffline = pageResult.status === "rejected" && Boolean(cached);
        setOffline(restoredOffline);
        if (!page) {
          setError("聊天记录暂时无法同步，请稍后重试。");
        }
        const currentHandoff =
          handoffResult.status === "fulfilled"
            ? handoffResult.value
            : restoredOffline
              ? page?.cachedHandoff
              : undefined;
        const currentCollaborations =
          collaborationResult.status === "fulfilled"
            ? collaborationResult.value
            : [];
        if (page) {
          setMessages(page.messages);
          messagesRef.current = page.messages;
          setNextCursor(page.nextCursor);
          shouldAutoFollowRef.current = true;
          setConversationRevision(page.conversationRevision);
        }
        setHandoff(currentHandoff);
        setHandoffUnavailable(
          handoffResult.status === "rejected" && !restoredOffline,
        );
        if (page && pageResult.status === "fulfilled") {
          await saveCachedTranscript(
            session.user.userId,
            id,
            page,
            currentHandoff,
          );
        }
        setCollaborations(currentCollaborations);
        if (currentHandoff?.state.cycleId) {
          const currentCycleId = currentHandoff.state.cycleId;
          const savedDraft =
            (await loadDraft(
              session.user.userId,
              id,
              currentCycleId,
            )) ??
            (await loadLatestConversationDraft(session.user.userId, id));
          if (savedDraft) {
            if (savedDraft.handoffId !== currentCycleId) {
              setArchivedDraftId(savedDraft.handoffId);
            }
            if (savedDraft.pendingMessage) {
              const storedPending = savedDraft.pendingMessage;
              const outcome = restoredOffline
                ? undefined
                : await getManualReplyOutcome(
                    session,
                    id,
                    storedPending.clientRequestId,
                  ).catch(() => undefined);
              const pendingMessage: DisplayMessage = outcome?.message ?? {
                messageId: `local:${savedDraft.pendingMessage.clientRequestId}`,
                actorType: "user",
                actorId: session.user.userId,
                direction: "outbound",
                contentType: "text",
                text: savedDraft.pendingMessage.text,
                sendState: "failed",
                sendErrorCode:
                  outcome?.status === "not_found" || outcome?.status === "failed"
                    ? "retryable_failed"
                    : "outcome_unknown",
                occurredAt: savedDraft.pendingMessage.occurredAt,
                clientRequestId: savedDraft.pendingMessage.clientRequestId,
                expectedConversationRevision:
                  savedDraft.pendingMessage.expectedConversationRevision,
              };
              const restoredMessages = mergeTimelineMessages(
                messagesRef.current,
                [pendingMessage],
              );
              messagesRef.current = restoredMessages;
              setMessages(restoredMessages);
              if (
                outcome?.message ||
                outcome?.status === "not_found" ||
                outcome?.status === "failed"
              ) {
                await deleteDraft(
                  session.user.userId,
                  id,
                  savedDraft.handoffId,
                );
              } else {
                setDraftFailure("outcome_unknown");
                setPendingOutcomeKey(storedPending.clientRequestId);
              }
            } else {
              setDraft(savedDraft.content);
              setReviewedAtRevision(savedDraft.reviewedAtRevision);
              setDraftStatus(
                restoredDraftForCycle(
                  savedDraft,
                  currentCycleId,
                  page?.conversationRevision,
                ),
              );
            }
          }
        }
        const latest = page?.messages.at(-1);
        if (latest && !restoredOffline) {
          lastReadMessageIdRef.current = latest.messageId;
          void markConversationRead(session, id, latest.messageId).catch(
            () => undefined,
          );
        }
      } catch {
        setError("暂时无法加载聊天记录，请返回后重试。");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, reloadKey]);
  // 草稿离页冲刷：卸载或退后台时立即落盘防抖窗口内尚未保存的最后一次输入。
  // 只读 refs（draftRef/persistDraftRef），不受 [] 依赖闭包过期影响。
  function flushPendingDraftSave() {
    const timer = draftSaveTimer.current;
    if (!timer) return;
    draftSaveTimer.current = null;
    clearTimeout(timer);
    persistDraftRef.current(draftRef.current);
  }
  // 取消未触发的防抖保存：发送/结束/丢弃草稿后，残留定时器会把已清除的
  // 文本重新写回草稿存储（发送成功后草稿"复活"）。
  function cancelPendingDraftSave() {
    if (!draftSaveTimer.current) return;
    clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = null;
  }
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setIsActive(state === "active");
      if (state !== "active") flushPendingDraftSave();
    });
    return () => {
      subscription.remove();
      flushPendingDraftSave();
    };
  }, []);
  // Brief 已读状态：首次进入当前 Cycle 默认 compact，再次进入默认 collapsed；
  // 首屏渲染后标记为已读（按 account+conversation+cycle 隔离，新 Cycle 视为未读）。
  useEffect(() => {
    if (!session || !id || !handoff?.state.cycleId) return;
    let active = true;
    void wasBriefRead(session.user.userId, id, handoff.state.cycleId).then(
      (read) => {
        if (active) setBriefDefaultMode(read ? "collapsed" : "compact");
      },
    );
    return () => {
      active = false;
    };
  }, [session, id, handoff?.state.cycleId]);
  useEffect(() => {
    if (!session || !id || !handoff?.state.cycleId) return;
    void markBriefRead(session.user.userId, id, handoff.state.cycleId);
  }, [session, id, handoff?.state.cycleId]);
  // 实时对账：SSE 事件驱动为主，这里每 30 秒回拉一次兜底（含接管/协作状态）
  useEffect(() => {
    if (!session || !id || !isActive) return;
    let disposed = false;
    async function refreshLiveState() {
      const [pageResult, handoffResult, collaborationResult] =
        await Promise.allSettled([
        getTranscript(session!, id!),
        getHandoff(session!, id!),
        listConversationCollaboration(session!, id!),
      ]);
      if (disposed) return;
      if (pageResult.status === "fulfilled") {
        const page = pageResult.value;
        setOffline(false);
        setError(undefined);
        // 服务端是唯一事实源：每次对账都合并（新增追加、已有行就地 patch）。
        // 无变化时 mergeTimelineMessages 返回原数组引用 → 不 setState、不重渲染，
        // 因此不需要「revision 未变就跳过」这种推断：它既会漏掉不改版本号的更新
        // （sendState 迁移、媒体转写回填），也会在本地版本被发送成功推进后
        // 把并发到达的客户消息误判成「无新内容」。
        const currentMessages = messagesRef.current;
        const newMessageCount = countNewTimelineMessages(
          currentMessages,
          page.messages,
        );
        const mergedMessages = mergeTimelineMessages(
          currentMessages,
          page.messages,
        );
        if (mergedMessages !== currentMessages) {
          messagesRef.current = mergedMessages;
          setMessages(mergedMessages);
        }
        if (newMessageCount > 0) {
          if (atBottomRef.current) shouldAutoFollowRef.current = true;
          else setUnseenCount((count) => count + newMessageCount);
          // 出现未见过的内容 → 草稿过期。用「未见过的消息数」而不是 revision
          // 比较：自己刚发的消息也会推进 revision，但那不是需要复核的新内容。
          setDraftStatus((status) =>
            draftRef.current && status !== "locked_reauth"
              ? "stale_revision"
              : status,
          );
        }
        if (page.conversationRevision !== undefined) {
          setConversationRevision(page.conversationRevision);
        }
        const latest = page.messages.at(-1);
        if (
          latest &&
          atBottomRef.current &&
          lastReadMessageIdRef.current !== latest.messageId
        ) {
          lastReadMessageIdRef.current = latest.messageId;
          void markConversationRead(session!, id!, latest.messageId).catch(
            () => undefined,
          );
        }
      } else {
        setOffline(true);
      }
      if (handoffResult.status === "fulfilled") {
        const previousHandoff = handoffRef.current;
        const previouslyOwned =
          previousHandoff?.state.status === "HUMAN_ACTIVE" &&
          previousHandoff.state.assignedUserId === session!.user.userId;
        setHandoff(handoffResult.value);
        setHandoffUnavailable(false);
        const refreshedOwner =
          handoffResult.value?.state.status === "HUMAN_ACTIVE" &&
          handoffResult.value.state.assignedUserId === session!.user.userId;
        if (!refreshedOwner) {
          setTransferOpen(false);
          setFinishOpen(false);
          if (
            previouslyOwned &&
            previousHandoff?.state.cycleId &&
            draftRef.current
          ) {
            setDraftStatus("archived_transfer");
            setArchivedDraftId(previousHandoff.state.cycleId);
            void saveDraft({
              accountId: session!.user.userId,
              conversationId: id!,
              handoffId: previousHandoff.state.cycleId,
              baseConversationRevision: revisionRef.current ?? null,
              reviewedAtRevision,
              content: draftRef.current,
              source: "manual",
              origin: "manual",
              edited: false,
              status: "archived_transfer",
              updatedAt: new Date().toISOString(),
            });
          }
        }
        if (pageResult.status === "fulfilled") {
          void saveCachedTranscript(
            session!.user.userId,
            id!,
            pageResult.value,
            handoffResult.value,
          );
        }
      } else {
        setHandoffUnavailable(true);
        setTransferOpen(false);
        setFinishOpen(false);
      }
      if (collaborationResult.status === "fulfilled") {
        setCollaborations(collaborationResult.value);
      }
    }
    const interval = setInterval(() => void refreshLiveState(), 30_000);
    void refreshLiveState();
    // 实时事件：本会话有新内容立即回拉（一轮 Agent 回复连发多条，去抖合并）。
    // 15s 轮询保留为对账兜底（SSE 断线/不支持时仍然工作）。
    let realtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeConversationEvents((event) => {
      if (event.conversationId !== id) return;
      if (realtimeTimer) clearTimeout(realtimeTimer);
      realtimeTimer = setTimeout(() => {
        realtimeTimer = undefined;
        void refreshLiveState();
      }, REALTIME_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      disposed = true;
      clearInterval(interval);
      if (realtimeTimer) clearTimeout(realtimeTimer);
      unsubscribe();
    };
  }, [id, isActive, reviewedAtRevision, session]);
  // 判断当前用户是否为会话负责人：只有负责人才能发送回复
  const isOwner = isDraftOwner(
    handoff?.state?.status,
    handoff?.state?.assignedUserId,
    session?.user.userId,
  );
  const canEditDraft = isOwner && draftStatus !== "archived_transfer";
  const canReply = canEditDraft && !offline && !handoffUnavailable;
  // Manual Takeover 入口：capability 开启且无 handoff（AGENT_ACTIVE）；
  // 可接管性最终由服务端原子裁决（点击后 409 即刷新为只读）
  const canTakeover = !handoff && capabilities.mobileManualTakeover;
  const uiState = deriveConversationUiState(
    handoff,
    session?.user.userId,
    offline,
    canTakeover,
  );
  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () =>
      setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(hideEvent, () =>
      setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  // Composer 出现时的轻过渡（claim 成功后 dock 从 CTA 变为输入区）
  useEffect(() => {
    if (uiState.mode !== "reply") {
      composerAppear.setValue(0);
      return;
    }
    Animated.timing(composerAppear, {
      toValue: 1,
      duration: reducedMotion ? 0 : 180,
      useNativeDriver: true,
    }).start();
  }, [uiState.mode, composerAppear, reducedMotion]);

  function markLatestAsRead(latest = messagesRef.current.at(-1)) {
    if (
      !session ||
      !id ||
      !latest ||
      lastReadMessageIdRef.current === latest.messageId
    )
      return;
    lastReadMessageIdRef.current = latest.messageId;
    void markConversationRead(session, id, latest.messageId).catch(
      () => undefined,
    );
  }

  async function loadOlderMessages() {
    if (!session || !id || !nextCursor || olderLoading || offline) return;
    setOlderLoading(true);
    setOlderError(undefined);
    try {
      const page = await getTranscript(session, id, nextCursor);
      const merged = mergeTimelineMessages(messagesRef.current, page.messages);
      messagesRef.current = merged;
      setMessages(merged);
      setNextCursor(page.nextCursor);
    } catch {
      setOlderError("更早的消息暂时无法加载");
    } finally {
      setOlderLoading(false);
    }
  }

  // 监听滚动位置：距离底部 72px 以内视为"在底部"，自动清除未读计数；
  // 离开底部时停止自动跟随，回到底部时恢复跟随
  function handleTimelineScroll(
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    const nearBottom = distanceFromBottom < 72;
    const wasNearBottom = atBottomRef.current;
    atBottomRef.current = nearBottom;
    // 用户开始阅读 Transcript（上滑超过阈值）→ 通知 Brief 自动折叠
    if (contentOffset.y > 120) {
      setTranscriptScrolled(true);
    }
    if (nearBottom) {
      if (!wasNearBottom) {
        shouldAutoFollowRef.current = true;
        markLatestAsRead();
      }
      if (unseenCount > 0) setUnseenCount(0);
    } else if (wasNearBottom) {
      shouldAutoFollowRef.current = false;
    }
  }

  // FlatList 首帧只渲染 initialNumToRender 条，剩余消息分批渲染，内容会多次变长；
  // 因此在用户主动上滑之前持续跟随到底部，而不是只在第一次内容变化时滚动一次
  function handleTimelineSizeChange() {
    if (!shouldAutoFollowRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: timelineReadyRef.current });
    timelineReadyRef.current = true;
  }

  function showLatestMessages() {
    setUnseenCount(0);
    atBottomRef.current = true;
    scrollRef.current?.scrollToEnd({ animated: true });
    markLatestAsRead();
  }

  async function claim() {
    if (!session || !id || !handoff) return;
    if (
      capabilities.handoffRevision &&
      handoff.state.handoffRevision === undefined
    ) return;
    const clientRequestId = claimRequestIdRef.current ?? Crypto.randomUUID();
    claimRequestIdRef.current = clientRequestId;
    setResponsibilityNotice(undefined);
    setActing(true);
    try {
      const state = await acceptHandoff(
        session,
        id,
        clientRequestId,
        capabilities.handoffRevision
          ? handoff.state.handoffRevision
          : undefined,
      );
      setHandoff((current) => ({
        state,
        cycles: current?.cycles ?? [],
        briefing: current?.briefing ?? null,
        activeTransferNote: current?.activeTransferNote ?? null,
      }));
      setHandoffUnavailable(false);
      claimRequestIdRef.current = undefined;
      // Claim 的轻仪式感：状态变化本身就是反馈，仅加轻触感
      Vibration.vibrate(10);
      // 立即同步列表（等待接手 → 我处理中），不等 30s 轮询
      notifyConversationRefresh();
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        (reason.code === "handoff_already_claimed" ||
          reason.code === "stale_handoff_revision" ||
          reason.code === "handoff_revision_conflict")
      ) {
        const current = await getHandoff(session, id).catch(() => undefined);
        if (current) setHandoff(current);
        else setHandoffUnavailable(true);
      } else if (capabilities.requestOutcome || capabilities.handoffOutcomeQuery) {
        try {
          const outcome = await getHandoffOperationOutcome(
            session,
            "claim_handoff",
            clientRequestId,
          );
          if (outcome.status === "succeeded" && outcome.result) {
            setHandoff((current) => ({
              state: outcome.result!,
              cycles: current?.cycles ?? [],
              briefing: current?.briefing ?? null,
        activeTransferNote: current?.activeTransferNote ?? null,
            }));
            claimRequestIdRef.current = undefined;
          } else {
            setResponsibilityNotice("正在确认接手结果，请不要重复操作。");
          }
        } catch {
          setResponsibilityNotice("暂时无法确认接手结果，网络恢复后请刷新。");
        }
      } else {
        const copy = actionErrorCopy(
          reason instanceof ApiError
            ? { code: reason.code, status: reason.status }
            : undefined,
        );
        setResponsibilityNotice([copy.title, copy.message].filter(Boolean).join("·"));
      }
    } finally {
      setActing(false);
    }
  }

  /**
   * 人工主动接管 AGENT_ACTIVE 会话（Manual Takeover）。
   * 服务端原子执行；幂等（clientRequestId 复用可安全重试）；
   * 竞争失败（409）刷新为服务端事实；结果未知时查询 outcome 兜底。
   */
  async function takeOver() {
    if (!session || !id) return;
    // 重新接管：resolve 后 handoff 仍存在但 state.status = HUMAN_FINISHED；
    // 允许在 finished 状态下继续 takeOver 创建新 cycle。
    if (handoff && handoff.state.status !== "HUMAN_FINISHED") return;
    const clientRequestId = takeoverRequestIdRef.current ?? Crypto.randomUUID();
    takeoverRequestIdRef.current = clientRequestId;
    setResponsibilityNotice(undefined);
    setActing(true);
    try {
      await takeOverHandoff(session, id, clientRequestId);
      takeoverRequestIdRef.current = undefined;
      // 接管成功：重新拉取权威 handoff（进入 reply 链路，Composer/转交/结束复用）
      const current = await getHandoff(session, id).catch(() => undefined);
      if (current) setHandoff(current);
      else setHandoffUnavailable(true);
      Vibration.vibrate(10);
      // 立即同步列表（Agent 处理中 → 我处理中），不等 30s 轮询
      notifyConversationRefresh();
    } catch (reason) {
      if (
        reason instanceof ApiError &&
        (reason.code === "handoff_already_claimed" ||
          reason.code === "invalid_handoff_transition" ||
          reason.code === "idempotency_conflict")
      ) {
        // 竞争失败/状态已变是正常结果：刷新为服务端事实（他人处理中或只读）
        const current = await getHandoff(session, id).catch(() => undefined);
        if (current) setHandoff(current);
        else setHandoffUnavailable(true);
      } else if (capabilities.requestOutcome || capabilities.handoffOutcomeQuery) {
        try {
          const outcome = await getHandoffOperationOutcome(
            session,
            "take_over",
            clientRequestId,
          );
          if (outcome.status === "succeeded") {
            const current = await getHandoff(session, id).catch(() => undefined);
            if (current) setHandoff(current);
            else setHandoffUnavailable(true);
            takeoverRequestIdRef.current = undefined;
          } else {
            setResponsibilityNotice("正在确认接管结果，请不要重复操作。");
          }
        } catch {
          setResponsibilityNotice("暂时无法确认接管结果，网络恢复后请刷新。");
        }
      } else {
        const copy = actionErrorCopy(
          reason instanceof ApiError
            ? { code: reason.code, status: reason.status }
            : undefined,
        );
        setResponsibilityNotice([copy.title, copy.message].filter(Boolean).join("·"));
      }
    } finally {
      setActing(false);
    }
  }

  async function rejectIncomingTransfer() {
    if (!session || !id || handoff?.state.handoffRevision === undefined) return;
    const clientRequestId = rejectRequestIdRef.current ?? Crypto.randomUUID();
    rejectRequestIdRef.current = clientRequestId;
    setActing(true);
    setResponsibilityNotice(undefined);
    try {
      const state = await rejectTransfer(session, id, {
        expectedHandoffRevision: handoff.state.handoffRevision,
        clientRequestId,
      });
      setHandoff((current) => ({
        state,
        cycles: current?.cycles ?? [],
        briefing: current?.briefing ?? null,
        activeTransferNote: current?.activeTransferNote ?? null,
      }));
      rejectRequestIdRef.current = undefined;
      setTimeout(() => router.back(), 220);
    } catch (reason) {
      if (
        !(reason instanceof ApiError && reason.status < 500) &&
        (capabilities.requestOutcome || capabilities.handoffOutcomeQuery)
      ) {
        try {
          const outcome = await getHandoffOperationOutcome(
            session,
            "reject_transfer",
            clientRequestId,
          );
          if (outcome.status === "succeeded" && outcome.result) {
            setHandoff((current) => ({
              state: outcome.result!,
              cycles: current?.cycles ?? [],
              briefing: current?.briefing ?? null,
        activeTransferNote: current?.activeTransferNote ?? null,
            }));
            rejectRequestIdRef.current = undefined;
            setTimeout(() => router.back(), 220);
          } else if (
            outcome.status === "not_found" ||
            outcome.status === "failed"
          ) {
            setResponsibilityNotice("已确认操作未完成，可以再次点击“无法接手”。");
          } else {
            setResponsibilityNotice("正在确认拒绝结果，请不要重复操作。");
          }
        } catch {
          setResponsibilityNotice("暂时无法确认拒绝结果，网络恢复后请刷新。");
        }
      } else {
        const copy = actionErrorCopy(
          reason instanceof ApiError
            ? { code: reason.code, status: reason.status }
            : undefined,
        );
        setResponsibilityNotice([copy.title, copy.message].filter(Boolean).join("·"));
      }
    } finally {
      setActing(false);
    }
  }
  async function submitCollaborationAnswer() {
    if (!session || !responseRequest || !responseText.trim()) return;
    setActing(true);
    try {
      const answered = await answerCollaborationRequest(
        session,
        responseRequest.requestId,
        responseText.trim(),
      );
      setCollaborations((current) =>
        current.map((request) =>
          request.requestId === answered.requestId ? answered : request,
        ),
      );
      setResponseRequest(undefined);
      setResponseText("");
    } catch (reason) {
      showActionError(reason);
    } finally {
      setActing(false);
    }
  }
  async function closeCollaboration(item: CollaborationRequest) {
    if (!session) return;
    setActing(true);
    try {
      const closed = await closeCollaborationRequest(session, item.requestId);
      setCollaborations((current) =>
        current.map((request) =>
          request.requestId === closed.requestId ? closed : request,
        ),
      );
    } catch (reason) {
      showActionError(reason);
    } finally {
      setActing(false);
    }
  }
  async function cancelCollaboration(item: CollaborationRequest) {
    if (!session) return;
    setActing(true);
    try {
      const cancelled = await cancelCollaborationRequest(
        session,
        item.requestId,
      );
      setCollaborations((current) =>
        current.map((request) =>
          request.requestId === cancelled.requestId ? cancelled : request,
        ),
      );
    } catch (reason) {
      showActionError(reason);
    } finally {
      setActing(false);
    }
  }
  function confirmCancelCollaboration(item: CollaborationRequest) {
    if (!session || item.status !== "pending" || acting) return;
    Alert.alert(
      "取消这次协作请求？",
      "取消后队列成员将不再看到该请求，已提交的意见不受影响。",
      [
        { text: "保留请求", style: "cancel" },
        {
          text: "取消请求",
          style: "destructive",
          onPress: () => void cancelCollaboration(item),
        },
      ],
    );
  }
  async function reviewLatestContent() {
    if (
      !session ||
      !id ||
      !handoff?.state.cycleId ||
      conversationRevision === undefined
    )
      return;
    setReviewedAtRevision(conversationRevision);
    setDraftStatus("saved_local");
    await saveDraft({
      accountId: session.user.userId,
      conversationId: id,
      handoffId: handoff.state.cycleId,
      baseConversationRevision: conversationRevision,
      reviewedAtRevision: conversationRevision,
      content: draft,
      source: "manual",
      origin: "manual",
      edited: false,
      status: "saved_local",
      updatedAt: new Date().toISOString(),
    });
  }
  // 发送回复：先乐观插入本地消息，再提交到服务端，失败时回滚状态
  async function send(
    mediaOptions?: {
      mediaId?: string;
      media?: { fileId: string; kind: "image" | "file" | "voice" };
      /** 素材空间引用：服务端派生 mediaId，无需重新上传文件字节 */
      assetId?: string;
      contentType?: string;
      text?: string;
    },
  ) {
    const text = mediaOptions?.text ?? draft.trim();
    if (
      !session ||
      !id ||
      (!text && !mediaOptions) ||
      !canReply ||
      (draftFailure === "outcome_unknown" || draftFailure === "outcome_pending") ||
      !canSendDraft(draftStatus, reviewedAtRevision, conversationRevision)
    )
      return;
    const clientRequestId = Crypto.randomUUID();
    const contentType = mediaOptions?.contentType ?? (mediaOptions ? "image" : "text");
    // 乐观插入：立即在聊天列表中显示发送中的消息
    const pending: DisplayMessage = {
      messageId: `local:${clientRequestId}`,
      actorType: "user",
      actorId: session.user.userId,
      direction: "outbound",
      contentType,
      mediaId: mediaOptions?.mediaId ?? null,
      text: text || (mediaOptions ? "[媒体文件]" : ""),
      sendState: "submitting",
      occurredAt: new Date().toISOString(),
      clientRequestId,
      expectedConversationRevision: conversationRevision,
      replyToChannelMessageId: replyTarget?.messageId ?? null,
    };
    shouldAutoFollowRef.current = true;
    atBottomRef.current = true;
    setMessages((current) => {
      const next = [...current, pending];
      messagesRef.current = next;
      return next;
    });
    // 发送启动即取消未触发的防抖保存：否则发送成功删除草稿后，
    // 残留定时器会把刚发出的文本重新写回草稿存储
    cancelPendingDraftSave();
    setDraft("");
    setDraftStatus(undefined);
    setDraftFailure(undefined);
    setReplyTarget(null);
    // 草稿删除延迟到成功路径：发送失败时需要把原文恢复回草稿，
    // 避免"请求发出前就删草稿 + 失败不恢复"造成用户文本永久丢失
    await submitManualReply(pending, mediaOptions);
  }
  async function submitManualReply(
    message: DisplayMessage,
    mediaOptions?: {
      mediaId?: string;
      media?: { fileId: string; kind: "image" | "file" | "voice" };
      assetId?: string;
    },
  ) {
    if (!session || !id || !message.clientRequestId) return;
    setActing(true);
    try {
      const submission = await sendManualReply(
        session,
        id,
        message.text,
        message.clientRequestId,
        message.expectedConversationRevision,
        {
          mediaId: mediaOptions?.mediaId ?? message.mediaId ?? undefined,
          media: mediaOptions?.media,
          assetId: mediaOptions?.assetId,
          replyToChannelMessageId: message.replyToChannelMessageId ?? undefined,
        },
      );
      setMessages((current) =>
        current.map((item) =>
          item.clientRequestId === message.clientRequestId
            ? submission.message
            : item,
        ),
      );
      // 同步服务端权威版本：否则 15s 后的轮询会把自己刚发的这条当成
      // 「会话有新内容」，把下一条草稿误标为过期并禁止发送。
      if (submission.conversationRevision !== undefined) {
        setConversationRevision(submission.conversationRevision);
      }
      if (submission.contextChanged) {
        showSendNotice("发送期间客户又发了新消息");
      }
      // 发送成功才删除草稿存储
      if (handoff?.state.cycleId) {
        await deleteDraft(session.user.userId, id, handoff.state.cycleId);
      }
    } catch (reason) {
      const failure = classifySendFailure(reason);
      setMessages((current) =>
        current.map((item) =>
          item.clientRequestId === message.clientRequestId
            ? { ...item, sendState: "failed", sendErrorCode: failure }
            : item,
        ),
      );
      setDraftFailure(failure);
      // 失败恢复草稿：权限丢失丢弃（账号已失效），其余失败把原文写回
      if (handoff?.state.cycleId) {
        const restored = restoreDraftAfterSendFailure({
          accountId: session.user.userId,
          conversationId: id,
          handoffId: handoff.state.cycleId,
          content: message.text,
          source: "manual",
          edited: false,
          reviewedAtRevision,
          failure,
        });
        if (restored) {
          setDraft(message.text);
          setDraftStatus("saved_local");
          await saveDraft({ ...restored, updatedAt: new Date().toISOString() });
        } else {
          await deleteDraft(session.user.userId, id, handoff.state.cycleId);
        }
      }
      if (handoff?.state.cycleId && failure === "outcome_unknown") {
        setPendingOutcomeKey(message.clientRequestId);
        await saveDraft({
          accountId: session.user.userId,
          conversationId: id,
          handoffId: handoff.state.cycleId,
          baseConversationRevision: conversationRevision ?? null,
          reviewedAtRevision,
          content: "",
          source: "manual",
          origin: "manual",
          status: "saved_local",
          pendingMessage: {
            clientRequestId: message.clientRequestId,
            text: message.text,
            occurredAt: message.occurredAt,
            expectedConversationRevision: message.expectedConversationRevision,
          },
          updatedAt: new Date().toISOString(),
        });
      }
      if (
        reason instanceof ApiError &&
        reason.code === "handoff_not_assignee"
      ) {
        showActionError(reason);
      }
    } finally {
      setActing(false);
    }
  }

  async function checkUnknownOutcome(
    message: DisplayMessage,
    options?: { silent?: boolean },
  ) {
    if (!session || !id || !message.clientRequestId) return;
    if (!options?.silent) setActing(true);
    try {
      const outcome = await getManualReplyOutcome(
        session,
        id,
        message.clientRequestId,
      );
      if (outcome.message) {
        setMessages((current) =>
          current.map((item) =>
            item.clientRequestId === message.clientRequestId
              ? outcome.message!
              : item,
          ),
        );
        setDraftFailure(undefined);
        setPendingOutcomeKey(undefined);
        if (handoff?.state.cycleId) {
          await deleteDraft(session.user.userId, id, handoff.state.cycleId);
        }
        return;
      }
      if (outcome.status === "not_found" || outcome.status === "failed") {
        setMessages((current) =>
          current.map((item) =>
            item.clientRequestId === message.clientRequestId
              ? { ...item, sendErrorCode: "retryable_failed" }
              : item,
          ),
        );
        setDraftFailure(undefined);
        setPendingOutcomeKey(undefined);
        if (handoff?.state.cycleId) {
          await deleteDraft(session.user.userId, id, handoff.state.cycleId);
        }
        return;
      }
      setDraftFailure("outcome_pending");
    } catch {
      setDraftFailure("outcome_unknown");
    } finally {
      if (!options?.silent) setActing(false);
    }
  }

  // 图片选择并发送
  async function pickAndSendImage() {
    if (!session || !id) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setMediaSending(true);
      const prepared = await prepareImageForUpload(asset);
      const uploaded = await uploadMedia(
        session,
        id,
        prepared.uri,
        prepared.fileName,
        prepared.mimeType,
      );
      await send({
        mediaId: uploaded.mediaId,
        media: { fileId: uploaded.mediaId, kind: uploaded.kind },
        contentType: "image",
      });
    } catch {
      Alert.alert("发送失败", "图片发送失败，请重试");
    } finally {
      setMediaSending(false);
    }
  }

  // 文件选择并发送
  async function pickAndSendFile() {
    if (!session || !id) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setMediaSending(true);
      const uploaded = await uploadMedia(
        session,
        id,
        asset.uri,
        asset.name ?? "file",
        asset.mimeType ?? "application/octet-stream",
      );
      await send({
        mediaId: uploaded.mediaId,
        media: { fileId: uploaded.mediaId, kind: "file" },
        contentType: "file",
        text: asset.name ?? "[文件]",
      });
    } catch {
      Alert.alert("发送失败", "文件发送失败，请重试");
    } finally {
      setMediaSending(false);
    }
  }

  // 拍一拍
  async function doPoke() {
    if (!session || !id) return;
    setMessageMenu(null);
    try {
      await pokeConversation(session, id);
    } catch {
      Alert.alert("操作失败", "拍一拍发送失败");
    }
  }

  // 素材空间：选中素材 → 服务端转发发送给客户（无需重新上传文件字节）
  async function pickAndSendAsset(asset: AssetItem) {
    if (!session || !id) return;
    setMediaSending(true);
    try {
      await send({
        assetId: asset.assetId,
        contentType: asset.category === "image" ? "image" : "file",
        text: asset.category === "image" ? "" : asset.name,
      });
    } catch {
      Alert.alert("发送失败", "素材发送失败，请重试");
    } finally {
      setMediaSending(false);
    }
  }

  // 设置回复目标
  function setReplyToMessage(msg: DisplayMessage) {
    setMessageMenu(null);
    setReplyTarget(msg);
  }

  /** 显示操作错误提示弹窗的页面内包装 */

  // 草稿持久化：最新渲染闭包存入 persistDraftRef，供防抖定时器与离页冲刷
  // 共享——冲刷发生在卸载/退后台时，必须读取最后一次渲染的 canEditDraft 等值。
  const persistDraftRef = useRef<(content: string) => void>(() => {});
  useEffect(() => {
    persistDraftRef.current = (content: string) => {
      if (!session || !id || !canEditDraft || !handoff?.state.cycleId) return;
      void saveDraft({
        accountId: session.user.userId,
        conversationId: id,
        handoffId: handoff.state.cycleId,
        baseConversationRevision: conversationRevision ?? null,
        reviewedAtRevision,
        content,
        source: "manual",
        origin: "manual",
        edited: false,
        status:
          draftStatus === "stale_revision" ? "stale_revision" : "saved_local",
        updatedAt: new Date().toISOString(),
      });
    };
  });
  // 草稿自动保存：输入停止 350ms 后保存到安全存储
  function onDraftChange(value: string) {
    if (!session || !id || !canEditDraft || !handoff?.state.cycleId) return;
    setDraft(value);
    if (draftStatus !== "stale_revision") setDraftStatus("saved_local");
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      draftSaveTimer.current = null;
      persistDraftRef.current(value);
    }, 350);
  }
  async function handleTransferred(state: HandoffDetail["state"]) {
    const previousCycleId = handoff?.state.cycleId;
    setHandoff((current) => ({
      state,
      cycles: current?.cycles ?? [],
      briefing: current?.briefing ?? null,
        activeTransferNote: current?.activeTransferNote ?? null,
    }));
    setTransferOpen(false);
    if (session && id && previousCycleId) {
      if (draft.trim()) {
        await saveDraft({
          accountId: session.user.userId,
          conversationId: id,
          handoffId: previousCycleId,
          baseConversationRevision: conversationRevision ?? null,
          reviewedAtRevision,
          content: draft,
          source: "manual",
          origin: "manual",
          edited: false,
          status: "archived_transfer",
          updatedAt: new Date().toISOString(),
        });
        setDraftStatus("archived_transfer");
        setArchivedDraftId(previousCycleId);
      } else {
        await deleteDraft(session.user.userId, id, previousCycleId);
        setDraftStatus(undefined);
      }
    }
    await refreshConversations(true);
  }

  async function handleFinished(state: HandoffDetail["state"]) {
    const cycleId = handoff?.state.cycleId;
    setHandoff((current) => ({
      state,
      cycles: current?.cycles ?? [],
      briefing: current?.briefing ?? null,
        activeTransferNote: current?.activeTransferNote ?? null,
    }));
    setFinishOpen(false);
    if (session && id && cycleId) {
      await deleteDraft(session.user.userId, id, cycleId);
    }
    cancelPendingDraftSave();
    setDraft("");
    // 立即同步列表（我处理中 → 全部移除），不等 30s 轮询
    notifyConversationRefresh();
    setTimeout(() => router.back(), 260);
  }
  async function discardArchivedDraft() {
    if (!session || !id || !archivedDraftId) return;
    await deleteDraft(session.user.userId, id, archivedDraftId);
    cancelPendingDraftSave();
    setArchivedDraftId(undefined);
    setDraft("");
    setDraftStatus(undefined);
  }
  // 根据会话状态计算标题、副标题和状态标签
  const title = conversationPreview?.name ?? `会话 · ${(id ?? "").slice(-8)}`;
  // Header 安静化：常态只显示公司/会话归属，实时同步是隐形基础设施；
  // 只有异常（离线）才提高视觉权重
  const subtitle = offline
    ? `${conversationPreview?.company || "会话"} · 离线`
    : conversationPreview
      ? conversationPreview.company || "客户会话"
      : canReply
        ? "我处理中"
        : "共享会话";
  // 状态标签：根据人工接管状态显示不同的处理阶段
  const statusLabel = handoff
    ? handoff.state.status === "TRANSFER_PENDING"
      ? handoff.state.targetUserId === session?.user.userId
        ? "等待你接手"
        : "等待接手"
      : handoff.state.status === "HANDOFF_PENDING"
      ? "等待接手"
      : canReply
        ? "我处理中"
        : handoff.state.status === "HUMAN_FINISHED"
          ? "人工处理已结束"
          : "他人处理中"
    : "Agent 处理中";
  // 状态色（文字为主、颜色为辅——状态不唯一依赖颜色）：
  // 待处理/转交=orange，我处理中=primary，其余中性
  const headerStatusColor =
    handoff?.state.status === "TRANSFER_PENDING" ||
    handoff?.state.status === "HANDOFF_PENDING"
      ? colors.orange
      : canReply
        ? colors.primary
        : colors.muted;
  // 交接摘要仅在「需要人工处理」的进行中 handoff 展示：
  // 无 handoff（Agent 处理中）或已结束（HUMAN_FINISHED）一律不显示。
  // 结构化 briefing 缺失时退回最小视图（headline + 交接原因），不再出现死态。
  const briefEligible = Boolean(
    handoff && handoff.state.status !== "HUMAN_FINISHED",
  );
  const briefing = briefEligible
    ? (handoffBriefingViewModel(handoff?.briefing) ??
      minimalHandoffBriefViewModel(
        handoff?.cycles.at(-1)?.reason ?? handoff?.activeTransferNote,
      ))
    : undefined;
  const hasUnknownManualMessage = messages.some(
    (message) => message.sendErrorCode === "outcome_unknown",
  );
  const hasActiveLegacyAssist = collaborations.some(
    (item) => item.status !== "closed" && item.status !== "cancelled",
  );
  const canChangeResponsibility =
    canReply && !hasUnknownManualMessage && !hasActiveLegacyAssist;
  const handoffContractReady =
    capabilities.mobileHandoffInbox && capabilities.handoffRevision;
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回会话列表"
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => pressed && styles.headerControlPressed}
        >
          <ArrowLeft size={23} color={colors.ink} weight="regular" />
        </Pressable>
        <View style={styles.headerText}>
          <Text numberOfLines={1} style={styles.name}>
            {title}
          </Text>
          <Text numberOfLines={1} style={styles.company}>
            {subtitle}
          </Text>
        </View>
        <Text style={[styles.headerStatus, { color: headerStatusColor }]}>
          {statusLabel}
        </Text>
        {session ? (
          <Pressable
            accessibilityLabel="联系人"
            onPress={() => setContactSheetOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [
              styles.moreButton,
              pressed && styles.headerControlPressed,
            ]}
          >
            <UserCircle size={24} color={colors.ink} />
          </Pressable>
        ) : null}
        {canReply || handoff?.state.status === "HUMAN_FINISHED" ? (
          <Pressable
            accessibilityLabel="更多会话操作"
            onPress={() => setConversationMenuOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [
              styles.moreButton,
              pressed && styles.headerControlPressed,
            ]}
          >
            <DotsThree size={25} color={colors.ink} weight="bold" />
          </Pressable>
        ) : null}
      </View>
      <KeyboardAvoidingView
        style={styles.keyboardArea}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={4}
      >
        <View style={styles.timelineArea}>
          {briefing ? (
            <HandoffBrief
              key={handoff?.state.cycleId ?? "no-cycle"}
              briefing={briefing}
              staleMessageCount={
                briefing.sourceConversationRevision > 0
                  ? Math.max(
                      0,
                      (conversationRevision ??
                        briefing.sourceConversationRevision) -
                        briefing.sourceConversationRevision,
                    )
                  : 0
              }
              transferNote={handoff?.activeTransferNote ?? null}
              defaultMode={briefDefaultMode}
              keyboardVisible={keyboardVisible}
              transcriptScrolled={transcriptScrolled}
            />
          ) : null}
          {uiState.mode === "reply" ? <CollaborationSummary
            requests={collaborations}
            onAnswer={(item) => {
              setResponseRequest(item);
              setResponseText("");
            }}
            onClose={(item) => void closeCollaboration(item)}
            onCancel={(item) => void confirmCancelCollaboration(item)}
            acting={acting || offline}
            currentUserId={session?.user.userId}
          /> : null}
          <FlatList
            ref={scrollRef}
            data={loading || error ? [] : messages}
            keyExtractor={(message) => message.messageId}
            contentContainerStyle={styles.chat}
            initialNumToRender={18}
            maxToRenderPerBatch={16}
            windowSize={9}
            removeClippedSubviews={Platform.OS === "android"}
            onScroll={handleTimelineScroll}
            onContentSizeChange={handleTimelineSizeChange}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              <View style={styles.timelineHeader}>
                {offline && (
                  <View style={styles.offlineBanner}>
                    <Text style={styles.offlineTitle}>离线 · 显示最近记录</Text>
                  </View>
                )}
                {!loading && messages.length > 0 && nextCursor && !offline && (
                  <Pressable
                    accessibilityRole="button"
                    disabled={olderLoading}
                    onPress={() => void loadOlderMessages()}
                    style={({ pressed }) => [
                      styles.loadOlder,
                      pressed && styles.loadOlderPressed,
                    ]}
                  >
                    {olderLoading ? (
                      <ActivityIndicator size="small" color={colors.blue} />
                    ) : (
                      <View style={styles.loadOlderContent}>
                        <ArrowUp size={13} color={colors.blue} />
                        <Text style={styles.loadOlderText}>加载更早的消息</Text>
                      </View>
                    )}
                  </Pressable>
                )}
                {olderError && (
                  <Pressable
                    onPress={() => void loadOlderMessages()}
                    style={styles.olderError}
                  >
                    <Text style={styles.olderErrorText}>
                      {olderError} · 点击重试
                    </Text>
                  </Pressable>
                )}
                {loading && (
                  <View style={styles.skeletonList}>
                    {[0, 1, 2, 3].map((i) => (
                      <View
                        key={i}
                        style={[
                          styles.skeletonRow,
                          i % 2 === 1 && styles.skeletonRowOutbound,
                        ]}
                      >
                        <View style={styles.skeletonBubble} />
                      </View>
                    ))}
                  </View>
                )}
                {error && (
                  <View style={styles.loadError}>
                    <Text style={styles.system}>{error}</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setReloadKey((key) => key + 1)}
                      style={({ pressed }) => [
                        styles.loadErrorAction,
                        pressed && styles.loadErrorActionPressed,
                      ]}
                    >
                      <Text style={styles.loadErrorActionText}>重新加载</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            }
            ListEmptyComponent={
              !loading && !error ? (
                <LoadState
                  description="新的客户消息会显示在这里"
                  kind="empty"
                  title="暂无可展示的聊天记录"
                />
              ) : null
            }
            renderItem={({ item: message, index }) => (
              <View style={styles.timelineItem}>
                {(index === 0 ||
                  !isSameDay(
                    messages[index - 1].occurredAt,
                    message.occurredAt,
                  )) && (
                  <Text style={styles.date}>
                    {formatDate(message.occurredAt)}
                  </Text>
                )}
                <TranscriptMessage
                  message={message}
                  session={session}
                  offline={offline}
                  contactId={
                    conversationPreview?.contactId ?? profileContactId
                  }
                  timeline={messages}
                  onLongPress={() => setMessageMenu({ message })}
                  onRetry={
                    message.sendState === "failed" && message.clientRequestId
                      ? message.sendErrorCode === "outcome_unknown"
                        ? () => void checkUnknownOutcome(message)
                        : !mayRetrySend(
                              message.sendErrorCode as SendFailureCode,
                              undefined,
                            )
                          ? undefined
                          : () => void submitManualReply(message)
                      : undefined
                  }
                />
              </View>
            )}
          />
          {unseenCount > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`有 ${unseenCount} 条新消息`}
              onPress={showLatestMessages}
              style={({ pressed }) => [
                styles.newMessages,
                pressed && styles.newMessagesPressed,
              ]}
            >
              <View style={styles.newMessageDot} />
              <Text style={styles.newMessagesText}>
                有 {unseenCount} 条新消息
              </Text>
              <ArrowDown size={13} color="colors.primary" weight="bold" />
            </Pressable>
          )}
        </View>
        <View
          style={[
            styles.bottomDock,
            { paddingBottom: keyboardVisible ? 0 : Math.max(insets.bottom, 8) },
          ]}
        >
        {handoffUnavailable || (handoff && !handoffContractReady) ? (
          <ActionPanel title="处理状态暂时无法确认" tone="muted" />
        ) : uiState.mode === "waiting" ? (
          draftStatus === "archived_transfer" && draft ? (
            <ArchivedDraftPanel
              title={
                handoff?.state.targetDisplayName
                  ? `已转交给 ${handoff.state.targetDisplayName}`
                  : "正在等待其他客服接手"
              }
              draft={draft}
              canStartNew={false}
              onStartNew={() => undefined}
            />
          ) : (
            <ActionPanel
              title={
                handoff?.state.targetDisplayName
                  ? `已转交给 ${handoff.state.targetDisplayName}`
                  : handoff?.state.targetQueueId || handoff?.state.assignedQueueId
                    ? `${handoff.state.targetDisplayName ?? "专业队列"}等待接手`
                    : "正在等待其他客服接手"
              }
              tone="muted"
            />
          )
        ) : uiState.mode === "transfer_offer" ? (
          <ActionPanel
            title="等待你接手"
            details={responsibilityNotice ? [responsibilityNotice] : undefined}
            action={acting ? "接手处理中…" : "接手处理"}
            tone="primary"
            onPress={() => void claim()}
            disabled={acting}
            secondaryLabel={
              uiState.availableActions.includes("reject_transfer")
                ? "无法接手"
                : undefined
            }
            onSecondary={
              uiState.availableActions.includes("reject_transfer")
                ? () => void rejectIncomingTransfer()
                : undefined
            }
          />
        ) : uiState.mode === "claim" ? (
          <ActionPanel
            title="Agent 需要人工继续处理"
            details={responsibilityNotice ? [responsibilityNotice] : undefined}
            action={acting ? "接手处理中…" : "接手处理"}
            tone="primary"
            onPress={() => void claim()}
            disabled={acting}
          />
        ) : (uiState.mode === "reply" || uiState.mode === "offline_draft") && canEditDraft ? (
          <Animated.View
            style={[
              styles.composerDock,
              {
                opacity: composerAppear,
                transform: [
                  {
                    translateY: composerAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [6, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <Composer
              draft={draft}
              onChange={onDraftChange}
              onSend={() => void send()}
              onTransfer={() => {
                if (canChangeResponsibility) setTransferOpen(true);
              }}
              transferEnabled={capabilities.transferCycle && (capabilities.transferToUser || capabilities.transferToQueue) && canChangeResponsibility}
              disabled={acting || mediaSending}
              offline={offline}
              draftStatus={draftStatus}
              draftFailure={draftFailure}
              notice={sendNotice}
              onReviewLatest={reviewLatestContent}
              reviewedAtRevision={reviewedAtRevision}
              conversationRevision={conversationRevision}
              replyTarget={replyTarget}
              onClearReply={() => setReplyTarget(null)}
              onPickImage={() => void pickAndSendImage()}
              onPickFile={() => void pickAndSendFile()}
              onPickAsset={() => setAssetPickerOpen(true)}
            />
          </Animated.View>
        ) : uiState.mode === "takeover" ? (
          <ActionPanel
            title="Agent 正在自动处理"
            details={responsibilityNotice ? [responsibilityNotice] : undefined}
            action={acting ? "接管中…" : "接管处理"}
            tone="primary"
            onPress={() => void takeOver()}
            disabled={acting}
          />
        ) : handoff?.state?.status === "HUMAN_FINISHED" ? (
          <ActionPanel
            title="本次人工处理已结束"
            details={
              capabilities.mobileManualTakeover
                ? ["点击下方按钮重新接管，由你继续人工处理。"]
                : undefined
            }
            action={acting ? "重新接管中…" : "重新接管"}
            tone="primary"
            disabled={acting || !capabilities.mobileManualTakeover}
            onPress={() => {
              setResponsibilityNotice(undefined);
              void takeOver();
            }}
          />
        ) : !handoff ? (
          <ActionPanel title="当前由 Agent 处理" tone="muted" />
        ) : draftStatus === "archived_transfer" && draft ? (
          <ArchivedDraftPanel
            title={
              handoff?.state.ownerDisplayName
                ? `${handoff.state.ownerDisplayName}正在处理`
                : "处理权限已变更"
            }
            draft={draft}
            canStartNew={isOwner}
            onStartNew={() => void discardArchivedDraft()}
          />
        ) : (
          <ActionPanel
            title={
              handoff?.state.ownerDisplayName
                ? `${handoff.state.ownerDisplayName}正在处理`
                : "其他客服处理中"
            }
            tone="muted"
          />
        )}
        </View>
        <CollaborationResponseModal
          request={responseRequest}
          text={responseText}
          onChangeText={setResponseText}
          onCancel={() => setResponseRequest(undefined)}
          onSubmit={() => void submitCollaborationAnswer()}
          submitting={acting}
        />
        <TransferSheet
          visible={transferOpen}
          session={session}
          conversationId={id ?? ""}
          handoffRevision={handoff?.state.handoffRevision}
          capabilities={capabilities}
          onClose={() => setTransferOpen(false)}
          onTransferred={(state) => void handleTransferred(state)}
        />
        <AssetPickerSheet
          visible={assetPickerOpen}
          session={session}
          onClose={() => setAssetPickerOpen(false)}
          onPicked={(asset) => void pickAndSendAsset(asset)}
        />
        <FinishHandoffSheet
          visible={finishOpen}
          session={session}
          conversationId={id ?? ""}
          handoffRevision={handoff?.state.handoffRevision}
          hasDraft={Boolean(draft.trim())}
          capabilities={capabilities}
          onClose={() => setFinishOpen(false)}
          onFinished={(state) => void handleFinished(state)}
        />
        <ConversationMenuModal
          visible={conversationMenuOpen}
          conversationId={id ?? ""}
          handoff={handoff}
          canReply={canReply && capabilities.humanFinish}
          canFinish={canChangeResponsibility && capabilities.humanFinish}
          transitionBlockedReason={
            hasUnknownManualMessage
              ? "请先确认结果未知的消息"
              : hasActiveLegacyAssist
                ? "请先结束当前专业协作"
                : undefined
          }
          currentUserId={session?.user.userId}
          collaborations={collaborations}
          onFinish={() => {
            setConversationMenuOpen(false);
            setFinishOpen(true);
          }}
          onCancelCollaboration={(item) => void confirmCancelCollaboration(item)}
          onOpenHistory={() => {
            setConversationMenuOpen(false);
            setHandoffHistoryOpen(true);
          }}
          onCloseCollaboration={(item) => void closeCollaboration(item)}
          onClose={() => setConversationMenuOpen(false)}
        />
        {contactProfileOpen && (
          <ContactProfileModal
            visible
            conversationId={id ?? ""}
            session={session}
            preview={conversationPreview}
            initialNoteFocus={noteFocus}
            onSaved={() => void refreshConversations()}
            onClose={() => {
              setContactProfileOpen(false);
              setNoteFocus(false);
            }}
          />
        )}
        {session && contactSheetOpen && (
          <ContactSheet
            visible
            session={session}
            conversationId={id ?? ""}
            onClose={() => setContactSheetOpen(false)}
            onRequestEdit={() => {
              setContactSheetOpen(false);
              setContactProfileOpen(true);
            }}
          />
        )}
        <HandoffHistorySheet
          visible={handoffHistoryOpen}
          cycles={handoff?.cycles ?? []}
          onClose={() => setHandoffHistoryOpen(false)}
        />
        {/* 消息长按操作菜单 */}
        {messageMenu && (
          <Modal
            visible
            transparent
            animationType="fade"
            onRequestClose={() => setMessageMenu(null)}
          >
            <Pressable
              style={styles.messageMenuBackdrop}
              onPress={() => setMessageMenu(null)}
            >
              <View style={styles.messageMenuSheet}>
                <Text style={styles.messageMenuTitle}>
                  {messageMenu.message.text
                    ? messageMenu.message.text.slice(0, 30) + (messageMenu.message.text.length > 30 ? "…" : "")
                    : "[消息]"}
                </Text>
                <Pressable
                  style={styles.messageMenuAction}
                  onPress={() => doPoke()}
                >
                  <Hand size={18} color={colors.ink} />
                  <Text style={styles.messageMenuActionText}>拍一拍</Text>
                </Pressable>
                <Pressable
                  style={styles.messageMenuAction}
                  onPress={() => setReplyToMessage(messageMenu.message)}
                >
                  <Reply size={18} color={colors.ink} />
                  <Text style={styles.messageMenuActionText}>回复</Text>
                </Pressable>
              </View>
            </Pressable>
          </Modal>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
