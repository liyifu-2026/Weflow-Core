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
import { Image } from "expo-image";
import { ArrowDown } from "phosphor-react-native/src/icons/ArrowDown";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { ArrowUp } from "phosphor-react-native/src/icons/ArrowUp";
import { ArrowsLeftRight } from "phosphor-react-native/src/icons/ArrowsLeftRight";
import { CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { DotsThree } from "phosphor-react-native/src/icons/DotsThree";
import { File } from "phosphor-react-native/src/icons/File";
import { Hand } from "phosphor-react-native/src/icons/Hand";
import { Image as ImageIcon } from "phosphor-react-native/src/icons/Image";
import { PaperPlaneRight } from "phosphor-react-native/src/icons/PaperPlaneRight";
import { Plus } from "phosphor-react-native/src/icons/Plus";
import { ArrowBendUpLeft as Reply } from "phosphor-react-native/src/icons/ArrowBendUpLeft";
import { UserCircle } from "phosphor-react-native/src/icons/UserCircle";
import { X } from "phosphor-react-native/src/icons/X";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LoadState } from "@/ui/load-state";
import { ApiError } from "@/api/client";
import { actionErrorCopy } from "@/api/action-error-copy";
import { apiBaseUrl } from "@/api/config";
import { loadSession, type MobileSession } from "@/auth/session";
import {
  acceptHandoff,
  getContactProfile,
  getHandoff,
  getManualReplyOutcome,
  getTranscript,
  getHandoffOperationOutcome,
  markConversationRead,
  rejectTransfer,
  sendManualReply,
  takeOverHandoff,
  updateContactProfile,
  pokeConversation,
  type ContactProfile,
  type HandoffDetail,
  type ServerMessage,
} from "@/conversations/api";
import { getMe } from "@/auth/api";
import { saveSession } from "@/auth/session";
import { TransferSheet } from "@/handoffs/transfer-sheet";
import { FinishHandoffSheet } from "@/handoffs/finish-sheet";
import {
  deleteDraft,
  loadDraft,
  loadLatestConversationDraft,
  saveDraft,
  type LocalDraft,
} from "@/conversations/draft-store";
import {
  canSendDraft,
  isDraftOwner,
  restoreDraftAfterSendFailure,
  restoredDraftForCycle,
} from "@/conversations/draft-lifecycle";
import {
  loadCachedTranscript,
  saveCachedTranscript,
} from "@/conversations/transcript-cache";
import { mayRetrySend, type SendFailureCode } from "@/conversations/safety";
import {
  contactTagsInput,
  normalizeContactTags,
} from "@/conversations/contact-profile";
import {
  countNewTimelineMessages,
  mergeTimelineMessages,
} from "@/conversations/timeline";
import { handoffBriefingViewModel, minimalHandoffBriefViewModel } from "@/conversations/handoff-briefing";
import {
  markBriefRead,
  wasBriefRead,
} from "@/conversations/brief-read-state";
import {
  HandoffBrief,
  type BriefMode,
} from "@/handoffs/brief-view";
import { ContactSheet } from "@/handoffs/contact-sheet";
import { MediaImage } from "@/media/media-image";
import { formatTime } from "@/ui/format";
import { MediaViewerModal } from "@/media/media-viewer";
import { uploadMedia } from "@/media/api";
import { VoiceBubble } from "@/media/voice-bubble";
import { HandoffHistorySheet } from "@/handoffs/handoff-history-sheet";
import { deriveConversationUiState } from "@/conversations/ui-state";
import { useConversationList } from "@/conversations/use-conversation-list";
import { notifyConversationRefresh } from "@/conversations/sync-store";
import type { ConversationPreview } from "@/conversations/model";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { useReducedMotion } from "@/ui/use-reduced-motion";
import { UserAvatar } from "@/ui/user-avatar";
import {
  answerCollaborationRequest,
  cancelCollaborationRequest,
  closeCollaborationRequest,
  listConversationCollaboration,
  type CollaborationRequest,
} from "@/collaboration/api";
import {
  emotionDisplayText,
  mentionSegments,
  messageKind,
  patNoticeText,
} from "@/conversations/message-presentation";

/** 展示用消息类型，扩展了客户端请求 ID 用于追踪发送状态 */
type DisplayMessage = ServerMessage & {
  clientRequestId?: string;
  expectedConversationRevision?: number;
};
/** 发送失败类型 */
type SendFailure =
  | "retryable_failed"
  | "rejected"
  | "permission_lost"
  | "outcome_unknown"
  | "outcome_pending";

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
  // 实时轮询：应用活跃时每 15 秒刷新聊天记录、人工接管和协作状态
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
        const currentMessages = messagesRef.current;
        const newMessageCount = countNewTimelineMessages(
          currentMessages,
          page.messages,
        );
        const mergedMessages = mergeTimelineMessages(
          currentMessages,
          page.messages,
        );
        messagesRef.current = mergedMessages;
        setMessages(mergedMessages);
        if (newMessageCount > 0) {
          if (atBottomRef.current) shouldAutoFollowRef.current = true;
          else setUnseenCount((count) => count + newMessageCount);
        }
        if (
          revisionRef.current !== undefined &&
          page.conversationRevision !== undefined &&
          page.conversationRevision !== revisionRef.current
        ) {
          setDraftStatus((status) =>
            draftRef.current && status !== "locked_reauth"
              ? "stale_revision"
              : status,
          );
        }
        setConversationRevision(page.conversationRevision);
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
    const interval = setInterval(() => void refreshLiveState(), 15_000);
    void refreshLiveState();
    return () => {
      disposed = true;
      clearInterval(interval);
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
      mediaId: string;
      media: { fileId: string; kind: "image" | "file" | "voice" };
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
      mediaId: string;
      media: { fileId: string; kind: "image" | "file" | "voice" };
    },
  ) {
    if (!session || !id || !message.clientRequestId) return;
    setActing(true);
    try {
      const sent = await sendManualReply(
        session,
        id,
        message.text,
        message.clientRequestId,
        message.expectedConversationRevision,
        {
          mediaId: mediaOptions?.mediaId ?? message.mediaId ?? undefined,
          media: mediaOptions?.media,
          replyToChannelMessageId: message.replyToChannelMessageId ?? undefined,
        },
      );
      setMessages((current) =>
        current.map((item) =>
          item.clientRequestId === message.clientRequestId ? sent : item,
        ),
      );
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

  async function checkUnknownOutcome(message: DisplayMessage) {
    if (!session || !id || !message.clientRequestId) return;
    setActing(true);
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
        if (handoff?.state.cycleId) {
          await deleteDraft(session.user.userId, id, handoff.state.cycleId);
        }
        return;
      }
      setDraftFailure("outcome_pending");
    } catch {
      setDraftFailure("outcome_unknown");
    } finally {
      setActing(false);
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
      const uploaded = await uploadMedia(
        session,
        id,
        asset.uri,
        asset.fileName ?? "image.jpg",
        asset.mimeType ?? "image/jpeg",
      );
      await send({
        mediaId: uploaded.mediaId,
        media: { fileId: uploaded.mediaId, kind: uploaded.kind },
        contentType: "image",
      });
    } catch (e) {
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
    } catch (e) {
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
              onReviewLatest={reviewLatestContent}
              reviewedAtRevision={reviewedAtRevision}
              conversationRevision={conversationRevision}
              replyTarget={replyTarget}
              onClearReply={() => setReplyTarget(null)}
              onPickImage={() => void pickAndSendImage()}
              onPickFile={() => void pickAndSendFile()}
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

function ArchivedDraftPanel({
  title,
  draft,
  canStartNew,
  onStartNew,
}: {
  title: string;
  draft: string;
  canStartNew: boolean;
  onStartNew: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.archivedDraftPanel}>
      <Text style={styles.archivedDraftTitle}>{title}</Text>
      <Text style={styles.archivedDraftHint}>
        未发送草稿已锁定，仅供查看或复制。
      </Text>
      <Text selectable style={styles.archivedDraftText}>
        {draft}
      </Text>
      {canStartNew ? (
        <Pressable onPress={onStartNew} hitSlop={8}>
          <Text style={styles.archivedDraftAction}>开始新的草稿</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ConversationMenuModal({
  visible,
  conversationId,
  handoff,
  canReply,
  canFinish,
  transitionBlockedReason,
  currentUserId,
  collaborations,
  onFinish,
  onCancelCollaboration,
  onCloseCollaboration,
  onOpenHistory,
  onClose,
}: {
  visible: boolean;
  conversationId: string;
  handoff?: HandoffDetail;
  canReply: boolean;
  canFinish: boolean;
  transitionBlockedReason?: string;
  currentUserId?: string;
  collaborations: CollaborationRequest[];
  onFinish: () => void;
  onCancelCollaboration: (request: CollaborationRequest) => void;
  onCloseCollaboration: (request: CollaborationRequest) => void;
  onOpenHistory: () => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const activeCollaborations = collaborations.filter(
    (item) =>
      item.kind === "assist" &&
      item.status !== "closed" &&
      item.status !== "cancelled",
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onClose}
    >
      <View style={styles.modalBackdrop}>
        <Pressable
          accessibilityLabel="关闭会话菜单"
          style={styles.menuDismiss}
          onPress={onClose}
        />
        <View style={styles.menuSheet}>
          <View style={styles.modalGrabber} />
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitle}>会话记录</Text>
              <Text style={styles.modalSub}>
                会话编号 · {conversationId.slice(-12)}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.modalClose}>关闭</Text>
            </Pressable>
          </View>
          {canReply ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="结束人工处理"
              disabled={!canFinish}
              onPress={() => {
                onClose();
                onFinish();
              }}
              style={({ pressed }) => [
                styles.menuActionRow,
                !canFinish && styles.menuActionRowDisabled,
                pressed && styles.menuActionRowPressed,
              ]}
            >
              <CheckCircle size={19} color={colors.blue} />
              <Text style={styles.menuActionText}>结束人工处理</Text>
            </Pressable>
          ) : null}
          {canReply && !canFinish && transitionBlockedReason ? (
            <Text style={styles.menuActionHint}>{transitionBlockedReason}</Text>
          ) : null}
          {activeCollaborations.length > 0 && (
            <>
              <Text style={styles.menuSectionLabel}>专业协作</Text>
              {activeCollaborations.map((item) => {
                const canCancel =
                  item.status === "pending" &&
                  item.createdByUserId === currentUserId;
                return (
                  <View key={item.requestId} style={styles.menuCollabRow}>
                    <View style={styles.menuCollabCopy}>
                      <Text style={styles.menuCollabTitle}>
                        请求协助 · {item.queueName ?? "专业队列"}
                      </Text>
                      <Text style={styles.menuCollabStatus}>
                        {item.status === "pending"
                          ? "等待队列成员提供意见"
                          : item.status === "claimed"
                            ? "已接手，等待提交意见"
                            : "已提交意见"}
                      </Text>
                    </View>
                    {item.status === "answered" && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="关闭此协作请求"
                        onPress={() => {
                          onClose();
                          onCloseCollaboration(item);
                        }}
                        style={({ pressed }) => [
                          styles.menuCollabAction,
                          pressed && styles.menuCollabActionPressed,
                        ]}
                      >
                        <Text style={styles.menuCollabActionText}>关闭</Text>
                      </Pressable>
                    )}
                    {canCancel && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="取消此协作请求"
                        onPress={() => {
                          onClose();
                          onCancelCollaboration(item);
                        }}
                        style={({ pressed }) => [
                          styles.menuCollabAction,
                          styles.menuCollabActionDanger,
                          pressed && styles.menuCollabActionPressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.menuCollabActionText,
                            styles.menuCollabActionTextDanger,
                          ]}
                        >
                          取消
                        </Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </>
          )}
          <Text style={styles.menuSectionLabel}>HANDOFF 历史</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="查看 Handoff 历史"
            onPress={() => {
              onClose();
              onOpenHistory();
            }}
            style={({ pressed }) => [
              styles.menuHistoryRow,
              pressed && styles.headerControlPressed,
            ]}
          >
            <Text style={styles.menuHistoryText}>
              {handoff && handoff.cycles.length > 0
                ? `${handoff.cycles.length} 个周期 · 查看完整记录`
                : "查看完整记录"}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
/** 联系人资料编辑弹窗：管理共享昵称、内部备注、标签和自动处理策略 */
function ContactProfileModal({
  visible,
  conversationId,
  session,
  preview,
  onSaved,
  onClose,
  initialNoteFocus = false,
}: {
  visible: boolean;
  conversationId: string;
  session?: MobileSession;
  preview?: ConversationPreview;
  onSaved: () => void;
  onClose: () => void;
  initialNoteFocus?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const [profile, setProfile] = useState<ContactProfile>();
  const [sharedAlias, setSharedAlias] = useState("");
  const [note, setNote] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [profileError, setProfileError] = useState<string>();
  const noteRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible && initialNoteFocus && noteRef.current && profile) {
      noteRef.current.focus();
    }
  }, [initialNoteFocus, profile, visible]);

  useEffect(() => {
    if (!visible || !session || !conversationId) return;
    let disposed = false;
    void getContactProfile(session, conversationId)
      .then((result) => {
        if (disposed) return;
        setProfile(result);
        setSharedAlias(result.sharedAlias ?? "");
        setNote(result.note ?? "");
        setTagsInput(contactTagsInput(result.tags));
        setProfileError(undefined);
      })
      .catch(() => {
        if (!disposed) setProfileError("联系人资料暂时无法加载，请稍后重试。");
      });
    return () => {
      disposed = true;
    };
  }, [conversationId, session, visible]);

  const normalizedTags = normalizeContactTags(tagsInput);
  const loading = visible && !profile && !profileError;
  const dirty = Boolean(
    profile &&
    (sharedAlias.trim() !== (profile.sharedAlias ?? "") ||
      note.trim() !== (profile.note ?? "") ||
      normalizedTags.join("\0") !== profile.tags.join("\0")),
  );

  async function saveProfile() {
    if (!session || !profile || !dirty || saving) return;
    if (normalizedTags.some((tag) => tag.length > 50)) {
      setProfileError("每个标签最多 50 个字符。");
      return;
    }
    setSaving(true);
    setSaved(false);
    setProfileError(undefined);
    try {
      const updated = await updateContactProfile(session, conversationId, {
        sharedAlias: sharedAlias.trim() || null,
        note: note.trim() || null,
        tags: normalizedTags,
      });
      setProfile(updated);
      setSharedAlias(updated.sharedAlias ?? "");
      setNote(updated.note ?? "");
      setTagsInput(contactTagsInput(updated.tags));
      setSaved(true);
      onSaved();
    } catch {
      setProfileError("资料没有保存，请检查网络后重试。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.profileBackdrop}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          accessibilityLabel="关闭联系人资料"
          style={styles.menuDismiss}
          onPress={onClose}
        />
        <View style={styles.profileSheet}>
          <View style={styles.modalGrabber} />
          <View style={styles.modalHeader}>
            <View style={styles.profileHeadingCopy}>
              <Text style={styles.modalTitle}>联系人资料</Text>
              <Text numberOfLines={1} style={styles.modalSub}>
                {preview?.name ?? "当前会话联系人"} ·{" "}
                {preview?.company ?? "共享会话"}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={styles.modalClose}>完成</Text>
            </Pressable>
          </View>
          {loading ? (
            <View style={styles.profileLoading}>
              <ActivityIndicator color={colors.blue} />
              <Text style={styles.profileLoadingText}>
                正在读取 Server2 资料
              </Text>
            </View>
          ) : !profile ? (
            <View style={styles.menuEmpty}>
              <Text style={styles.menuEmptyTitle}>
                {profileError ?? "暂无联系人资料"}
              </Text>
              <Pressable onPress={onClose}>
                <Text style={styles.profileRetry}>稍后再试</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.profileIdentity}>
                <View style={styles.contactAvatar}>
                  <Text style={styles.contactAvatarText}>
                    {(preview?.name ?? "客").slice(0, 1)}
                  </Text>
                </View>
                <View style={styles.contactCopy}>
                  <Text style={styles.contactName}>
                    {preview?.name ?? "当前联系人"}
                  </Text>
                  <Text style={styles.contactCompany}>
                    {profile.channelDisplayName ||
                      profile.channelNickname ||
                      "微信联系人"}{" "}
                    · ID 尾号 {profile.channelContactId.slice(-8)}
                  </Text>
                </View>
              </View>
              <Text style={styles.profileLabel}>共享昵称</Text>
              <TextInput
                accessibilityLabel="客户共享昵称"
                value={sharedAlias}
                onChangeText={(value) => {
                  setSharedAlias(value);
                  setSaved(false);
                  setProfileError(undefined);
                }}
                placeholder="所有客服共同看到的客户名称"
                placeholderTextColor={colors.muted}
                maxLength={120}
                style={styles.profileTagsInput}
              />
              <Text style={styles.profileHint}>
                留空时显示微信名称，修改会保留记录。
              </Text>
              <Text style={styles.profileLabel}>内部备注</Text>
              <TextInput
                ref={noteRef}
                accessibilityLabel="联系人内部备注"
                value={note}
                onChangeText={(value) => {
                  setNote(value);
                  setSaved(false);
                  setProfileError(undefined);
                }}
                placeholder="添加帮助同事识别客户的备注"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={2000}
                style={styles.profileNoteInput}
              />
              <Text style={styles.profileCounter}>
                {note.length}/2000 · 仅内部可见
              </Text>
              <Text style={styles.profileLabel}>标签</Text>
              <TextInput
                accessibilityLabel="联系人标签"
                value={tagsInput}
                onChangeText={(value) => {
                  setTagsInput(value);
                  setSaved(false);
                  setProfileError(undefined);
                }}
                placeholder="例如：重点客户，需回访"
                placeholderTextColor={colors.muted}
                style={styles.profileTagsInput}
              />
              <Text style={styles.profileHint}>
                使用逗号分隔，保存时会自动去重。
              </Text>
              {profileError && (
                <Text accessibilityRole="alert" style={styles.profileError}>
                  {profileError}
                </Text>
              )}
              {saved && (
                <Text accessibilityRole="alert" style={styles.profileSaved}>
                  资料已保存
                </Text>
              )}
              <Pressable
                accessibilityRole="button"
                disabled={!dirty || saving}
                onPress={() => void saveProfile()}
                style={({ pressed }) => [
                  styles.profileSave,
                  (!dirty || saving) && styles.profileSaveDisabled,
                  pressed && dirty && styles.profileSavePressed,
                ]}
              >
                {saving ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.profileSaveText}>保存联系人资料</Text>
                )}
              </Pressable>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
/** 聊天消息气泡组件：根据消息类型（客户/AI/人工/系统）渲染不同样式 */
function TranscriptMessage({
  message,
  session,
  offline,
  contactId,
  timeline,
  onRetry,
  onLongPress,
}: {
  message: DisplayMessage;
  session?: MobileSession;
  offline?: boolean;
  /** 联系人头像数据源（客户消息侧） */
  contactId?: string | null;
  /** 当前聊天记录，用于查找引用回复的原消息 */
  timeline?: DisplayMessage[];
  onRetry?: () => void;
  onLongPress?: () => void;
}) {
  // colors 由子组件 MediaImage 内部处理
  const styles = useThemedStyles(createStyles);
  const [imageOpen, setImageOpen] = useState(false);
  // 时间戳默认不渲染：点击气泡切换显示（微信式省视觉噪音）
  const [showTime, setShowTime] = useState(false);
  // 拍一拍：以「对方拍了拍你」样式居中提示，不进入聊天气泡
  const patNotice = patNoticeText(message);
  if (patNotice)
    return (
      <View style={styles.patNotice}>
        <Text style={styles.patNoticeText}>{patNotice}</Text>
      </View>
    );
  const kind = messageKind(message.actorType, message.direction);
  if (kind === "system")
    return (
      <View style={styles.systemEvent}>
        <View style={styles.systemLine} />
        <Text style={styles.system}>
          {formatTime(message.occurredAt)} · {message.text || "状态已更新"}
        </Text>
        <View style={styles.systemLine} />
      </View>
    );
  const right = kind !== "customer";
  const label =
    kind === "agent" ? "Agent" : kind === "manual" ? "人工客服" : "客户";
  const isImageMessage = message.contentType === "image";
  // 表情包消息：纯文本 [表情包]<含义>，不渲染图片
  const stickerText = emotionDisplayText(message);
  // 引用回复：在当前聊天记录中查找被引用的原消息
  const quotedMsg = message.replyToChannelMessageId
    ? timeline?.find((m) => m.messageId === message.replyToChannelMessageId)
    : undefined;
  const quotedLabel = quotedMsg
    ? messageKind(quotedMsg.actorType, quotedMsg.direction) === "customer"
      ? "客户"
      : messageKind(quotedMsg.actorType, quotedMsg.direction) === "agent"
        ? "Agent"
        : "人工客服"
    : "";
  const quotedText = quotedMsg
    ? ((quotedMsg.text || "").trim().length > 0
      ? (quotedMsg.text || "").trim().slice(0, 40) + ((quotedMsg.text || "").trim().length > 40 ? "…" : "")
      : "〔非文本消息〕")
    : "";
  // @提及分段渲染
  const displayText = stickerText ?? (isImageMessage ? "图片需联网查看" : message.text || "[非文本消息]");
  const segments = stickerText === null && !isImageMessage ? mentionSegments(displayText) : [];
  const hasMentions = segments.some((s) => s.mention);
  return (
    <>
      <View
        accessible={!isImageMessage}
        accessibilityLabel={`${label}，${isImageMessage ? "图片消息" : message.text || "非文本消息"}${showTime ? `，${formatTime(message.occurredAt)}` : ""}`}
        style={[styles.messageRow, right ? styles.right : styles.left]}
      >
        {kind === "customer" ? (
          <MessageAvatar
            kind="customer"
            contactId={contactId}
            fallbackName={label}
            sessionToken={session?.sessionToken}
          />
        ) : null}
        <Pressable
          accessibilityLabel={isImageMessage ? "查看图片" : undefined}
          onPress={() => setShowTime((visible) => !visible)}
          onLongPress={onLongPress}
          delayLongPress={450}
          style={[
            styles.bubble,
            kind === "customer"
              ? styles.customer
              : kind === "manual"
                ? styles.me
                : styles.agent,
          ]}
        >
          {quotedMsg ? (
            <View style={styles.quoteCard}>
              <Text style={styles.quoteAuthor}>{quotedLabel}</Text>
              <Text style={styles.quoteText} numberOfLines={1}>
                {quotedText}
              </Text>
            </View>
          ) : null}
          {isImageMessage && message.mediaId && session ? (
            <MediaImage
              session={session}
              mediaId={message.mediaId}
              offline={Boolean(offline)}
              onOpen={() => setImageOpen(true)}
            />
          ) : message.contentType === "voice" && message.mediaId && session ? (
            <VoiceBubble
              session={session}
              mediaId={message.mediaId}
              offline={Boolean(offline)}
            />
          ) : stickerText !== null ? (
            <Text
              style={[styles.messageText, kind === "manual" && styles.meText]}
            >
              {stickerText}
            </Text>
          ) : hasMentions ? (
            <Text
              style={[styles.messageText, kind === "manual" && styles.meText]}
            >
              {segments.map((seg, i) =>
                seg.mention ? (
                  <Text key={i} style={[styles.mentionText, kind === "manual" && styles.mentionTextOnDark]}>
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
              )}
            </Text>
          ) : (
            <Text
              style={[styles.messageText, kind === "manual" && styles.meText]}
            >
              {isImageMessage
                ? "图片需联网查看"
                : message.text || "[非文本消息]"}
            </Text>
          )}
          {kind === "manual" && message.sendState && (
            <Pressable onPress={onRetry} disabled={!onRetry}>
              <Text style={styles.pending}>
                {message.sendState === "failed"
                  ? failureCopy(message.sendErrorCode)
                  : sendStateCopy(message.sendState)}
              </Text>
            </Pressable>
          )}
          {showTime ? (
            <Text
              style={[
                styles.messageTime,
                kind === "manual" && styles.messageTimeOnDark,
              ]}
            >
              {formatTime(message.occurredAt)}
            </Text>
          ) : null}
        </Pressable>
        {kind === "agent" ? (
          <MessageAvatar
            kind="agent"
            avatarUrl={message.actorAvatarUrl ?? null}
            sessionToken={session?.sessionToken}
          />
        ) : kind === "manual" ? (
          <MessageAvatar
            kind="manual"
            avatarUrl={session?.user.avatarUrl ?? null}
            sessionToken={session?.sessionToken}
            initial={(
              session?.user.displayName ||
              session?.user.username ||
              "客"
            ).slice(0, 1)}
          />
        ) : null}
      </View>
      {imageOpen && message.mediaId && session && (
        <MediaViewerModal
          session={session}
          mediaId={message.mediaId}
          onClose={() => setImageOpen(false)}
        />
      )}
    </>
  );
}

/**
 * 消息头像组件：
 * - 客户：经 Core 头像代理拉取联系人头像（与 Console 同源），缺失回退用户图标；
 * - 人工客服：auth me 的 avatarUrl（Console 换头像后同步显示），缺失回退首字母；
 * - AI 员工：平台 DiceBear 代理按员工标识确定性出图（voxel-bot），加载失败
 *   回退固定标识；不同员工头像不同，可区分是哪个 AI 发的消息。
 */
function MessageAvatar({
  kind,
  initial,
  contactId,
  fallbackName,
  avatarUrl,
  sessionToken,
}: {
  kind: "customer" | "agent" | "manual";
  initial?: string;
  contactId?: string | null;
  fallbackName?: string;
  avatarUrl?: string | null;
  sessionToken?: string;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [agentAvatarFailed, setAgentAvatarFailed] = useState(false);
  if (kind === "customer" && contactId && sessionToken) {
    return (
      <UserAvatar
        contactId={contactId}
        fallbackName={fallbackName || "客"}
        sessionToken={sessionToken}
        size={27}
      />
    );
  }
  if (
    kind === "agent" &&
    avatarUrl &&
    sessionToken &&
    !agentAvatarFailed
  ) {
    return (
      <Image
        source={{
          uri: `${apiBaseUrl}${avatarUrl}`,
          headers: { authorization: `Bearer ${sessionToken}` },
        }}
        style={styles.messageAvatarImage}
        onError={() => setAgentAvatarFailed(true)}
        accessibilityLabel="AI 员工头像"
      />
    );
  }
  return (
    <View
      style={[
        styles.messageAvatar,
        kind === "manual"
          ? styles.messageAvatarManual
          : kind === "agent"
            ? styles.messageAvatarAgent
            : styles.messageAvatarCustomer,
      ]}
    >
      {kind === "agent" ? (
        <Text style={styles.messageAvatarAgentText}>A</Text>
      ) : kind === "manual" && avatarUrl && sessionToken ? (
        <Image
          source={{
            uri: `${apiBaseUrl}${avatarUrl}`,
            headers: { authorization: `Bearer ${sessionToken}` },
          }}
          style={styles.messageAvatarImage}
          accessibilityLabel="客服头像"
        />
      ) : kind === "customer" ? (
        <UserCircle size={14} color={colors.muted} weight="fill" />
      ) : (
        <Text style={styles.messageAvatarText}>{initial}</Text>
      )}
    </View>
  );
}

function sendStateCopy(state: string) {
  return state === "pending"
    ? "等待发送"
    : state === "submitting"
      ? "发送中"
      : state === "confirmed" || state === "observed"
        ? "已发送"
        : state;
}
/** 发送失败文案映射 */
function failureCopy(code?: string | null) {
  if (code === "outcome_unknown") return "结果未知 · 点击查询执行结果";
  if (code === "permission_lost") return "权限已变化 · 会话已切换为只读";
  if (code === "rejected") return "发送被拒绝";
  return "发送失败 · 点击重试";
}
/** 将 API 错误分类为发送失败类型 */
function classifySendFailure(reason: unknown): SendFailure {
  if (reason instanceof ApiError) {
    if (reason.code === "handoff_not_assignee") return "permission_lost";
    if (reason.status >= 400 && reason.status < 500) return "rejected";
    return "outcome_unknown";
  }
  return "outcome_unknown";
}
function isSameDay(first: string, second: string) {
  const firstDate = new Date(first);
  const secondDate = new Date(second);
  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}
function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "会话记录";
  const today = new Date();
  if (isSameDay(today.toISOString(), value)) return "今天";
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}
/** 显示操作错误提示弹窗 */
function showActionError(reason: unknown) {
  const copy = actionErrorCopy(
    reason instanceof ApiError
      ? { code: reason.code, status: reason.status }
      : undefined,
  );
  Alert.alert(copy.title, copy.message);
}
/** 协作请求摘要组件：展示当前活跃的协助请求及操作按钮 */
function CollaborationSummary({
  requests,
  onAnswer,
  onClose,
  onCancel,
  acting,
  currentUserId,
}: {
  requests: CollaborationRequest[];
  onAnswer: (request: CollaborationRequest) => void;
  onClose: (request: CollaborationRequest) => void;
  onCancel: (request: CollaborationRequest) => void;
  acting: boolean;
  currentUserId?: string;
}) {
  const styles = useThemedStyles(createStyles);
  const active = requests.filter(
    (item) =>
      item.kind === "assist" &&
      item.status !== "closed" &&
      item.status !== "cancelled",
  );
  if (active.length === 0) return null;
  return (
    <View style={styles.collaborationPanel}>
      <Text style={styles.collaborationLabel}>专业协作</Text>
      {active.map((item) => {
        const canCancel =
          item.status === "pending" &&
          item.createdByUserId === currentUserId;
        return (
          <Pressable
            key={item.requestId}
            disabled={!canCancel || acting}
            onLongPress={() => {
              if (canCancel) onCancel(item);
            }}
            delayLongPress={450}
            accessibilityLabel={
              canCancel ? "长按取消此协作请求" : undefined
            }
            style={({ pressed }) => [
              styles.collaborationRow,
              pressed && styles.collaborationRowPressed,
            ]}
          >
            <View style={styles.collaborationCopy}>
              <Text style={styles.collaborationTitle}>
                请求协助 · {item.queueName ?? "专业队列"}
              </Text>
              <Text style={styles.collaborationStatus}>
                {item.status === "pending"
                  ? "等待队列成员提供意见"
                  : item.status === "claimed"
                    ? "已接手，等待提交意见"
                    : item.status === "answered"
                      ? "已提交意见"
                      : item.status}
              </Text>
              {item.claimSummary && item.status === "pending" && (
                <Text numberOfLines={2} style={styles.collaborationReason}>
                  {item.claimSummary}
                </Text>
              )}
            </View>
            {item.status === "claimed" && (
              <Pressable
                disabled={acting}
                onPress={() => onAnswer(item)}
                style={styles.collaborationButton}
              >
                <Text style={styles.collaborationButtonText}>提交意见</Text>
              </Pressable>
            )}
            {item.status === "answered" && (
              <Pressable
                disabled={acting}
                onPress={() => onClose(item)}
                style={styles.collaborationSecondaryButton}
              >
                <Text style={styles.collaborationSecondaryText}>关闭</Text>
              </Pressable>
            )}
            {item.status === "pending" && canCancel && (
              <Text style={styles.collaborationHint}>长按取消</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
/** 协作意见提交弹窗 */
function CollaborationResponseModal({
  request,
  text,
  onChangeText,
  onCancel,
  onSubmit,
  submitting,
}: {
  request?: CollaborationRequest;
  text: string;
  onChangeText: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  return (
    <Modal
      visible={Boolean(request)}
      transparent
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={onCancel}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.responseSheet}>
          <Text style={styles.modalTitle}>提交专业意见</Text>
          <Text style={styles.modalHint}>
            这段内容只会出现在协作请求中，不会发送给客户。
          </Text>
          <TextInput
            value={text}
            onChangeText={onChangeText}
            multiline
            autoFocus
            placeholder="写下判断、建议或需要补充确认的事项…"
            placeholderTextColor={colors.muted}
            style={styles.responseInput}
          />
          <View style={styles.modalActions}>
            <Pressable onPress={onCancel} style={styles.modalCancel}>
              <Text style={styles.modalCancelText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={onSubmit}
              disabled={submitting || !text.trim()}
              style={[
                styles.modalConfirm,
                (submitting || !text.trim()) && styles.sendDisabled,
              ]}
            >
              <Text style={styles.modalConfirmText}>
                {submitting ? "提交中" : "提交意见"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
/** 当前 owner 的精简回复框：草稿、转交与联系人资料。 */
function Composer({
  draft,
  onChange,
  onSend,
  onTransfer,
  transferEnabled,
  onReviewLatest,
  disabled,
  offline,
  draftStatus,
  draftFailure,
  reviewedAtRevision,
  conversationRevision,
  replyTarget,
  onClearReply,
  onPickImage,
  onPickFile,
}: {
  draft: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onTransfer: () => void;
  transferEnabled: boolean;
  onReviewLatest: () => void;
  disabled: boolean;
  offline: boolean;
  draftStatus?: LocalDraft["status"];
  draftFailure?: SendFailure;
  reviewedAtRevision: number | null;
  conversationRevision?: number;
  replyTarget?: DisplayMessage | null;
  onClearReply?: () => void;
  onPickImage?: () => void;
  onPickFile?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const [toolsOpen, setToolsOpen] = useState(false);
  // 输入框单行时文字垂直居中、多行时顶对齐（与 +/发送按钮对齐的关键）
  const [inputMultiline, setInputMultiline] = useState(false);
  const [toolsProgress] = useState(() => new Animated.Value(0));
  // 版本阻塞：草稿过期且用户未确认最新内容时禁止发送
  const blockedByRevision =
    draftStatus === "stale_revision" &&
    reviewedAtRevision !== conversationRevision;
  const blockedByUnknownOutcome =
    draftFailure === "outcome_unknown" || draftFailure === "outcome_pending";
  useEffect(() => {
    Animated.spring(toolsProgress, {
      toValue: toolsOpen ? 1 : 0,
      damping: 22,
      stiffness: 260,
      useNativeDriver: true,
    }).start();
  }, [toolsOpen, toolsProgress]);

  function toggleTools() {
    if (toolsOpen) {
      setToolsOpen(false);
      return;
    }
    Keyboard.dismiss();
    setToolsOpen(true);
  }

  function runTool(action: () => void) {
    setToolsOpen(false);
    action();
  }
  return (
    <View style={styles.composer}>
      {/* 引用回复预览条 */}
      {replyTarget && onClearReply ? (
        <View style={styles.replyPreview}>
          <View style={styles.replyPreviewContent}>
            <Text style={styles.replyPreviewLabel}>
              回复 {messageKind(replyTarget.actorType, replyTarget.direction) === "customer" ? "客户" : messageKind(replyTarget.actorType, replyTarget.direction) === "agent" ? "Agent" : "人工客服"}
            </Text>
            <Text style={styles.replyPreviewText} numberOfLines={1}>
              {replyTarget.text || "[非文本消息]"}
            </Text>
          </View>
          <Pressable onPress={onClearReply} hitSlop={8}>
            <X size={14} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}
      <View style={styles.inputRow}>
        <Pressable
          accessibilityLabel="更多操作"
          onPress={toggleTools}
          disabled={disabled || offline}
          style={({ pressed }) => [
            styles.plusButton,
            pressed && styles.toolButtonPressed,
          ]}
        >
          {toolsOpen ? (
            <X size={20} color={colors.ink} />
          ) : (
            <Plus size={22} color={colors.ink} weight="regular" />
          )}
        </Pressable>
        <TextInput
          accessibilityLabel="输入回复"
          value={draft}
          onChangeText={onChange}
          editable={!disabled && draftStatus !== "locked_reauth"}
          placeholder="输入给客户的回复…"
          placeholderTextColor={colors.muted}
          multiline
          maxLength={2000}
          onContentSizeChange={(event) => {
            setInputMultiline(event.nativeEvent.contentSize.height > 44);
          }}
          onFocus={() => {
            setToolsOpen(false);
          }}
          style={[styles.input, inputMultiline && styles.inputMultiline]}
        />
        {draft.trim() ? (
          <Pressable
            accessibilityLabel="发送回复"
            disabled={disabled || offline || blockedByRevision || blockedByUnknownOutcome}
            onPress={onSend}
            style={({ pressed }) => [
              styles.send,
              (disabled || offline || blockedByRevision || blockedByUnknownOutcome) && styles.sendDisabled,
              pressed && styles.sendPressed,
            ]}
          >
            {disabled ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <PaperPlaneRight size={19} color={colors.onPrimary} weight="fill" />
            )}
          </Pressable>
        ) : null}
      </View>
      {!toolsOpen && draft.length > 1800 && (
        <View style={styles.composerMeta}>
          <Text style={styles.characterCount}>{draft.length}/2000</Text>
        </View>
      )}
      {offline ? (
        <Text style={styles.offlineDraft}>离线 · 草稿已保存在本机</Text>
      ) : null}
      {toolsOpen && (
        <Animated.View
          style={[
            styles.moreActions,
            !reducedMotion && {
              opacity: toolsProgress,
              transform: [
                {
                  translateY: toolsProgress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [8, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Pressable
            onPress={() => runTool(onTransfer)}
            disabled={disabled || !transferEnabled}
            style={styles.moreActionButton}
          >
            <ArrowsLeftRight size={20} color={colors.ink} />
            <Text style={styles.moreActionTitle}>转交处理</Text>
          </Pressable>
          <Pressable
            onPress={() => runTool(onPickImage ?? (() => {}))}
            disabled={disabled}
            style={styles.moreActionButton}
          >
            <ImageIcon size={20} color={colors.ink} />
            <Text style={styles.moreActionTitle}>图片</Text>
          </Pressable>
          <Pressable
            onPress={() => runTool(onPickFile ?? (() => {}))}
            disabled={disabled}
            style={styles.moreActionButton}
          >
            <File size={20} color={colors.ink} />
            <Text style={styles.moreActionTitle}>文件</Text>
          </Pressable>
        </Animated.View>
      )}
      {draftStatus === "stale_revision" && (
        <Pressable onPress={onReviewLatest} style={styles.draftStale}>
          <Text style={styles.draftWarning}>
            会话已有新内容，请先查看后继续
          </Text>
          <Text style={styles.draftReview}>已检查最新内容，继续使用草稿</Text>
        </Pressable>
      )}
      {(draftFailure === "outcome_unknown" || draftFailure === "outcome_pending") && (
        <Text style={styles.draftWarning}>
          {draftFailure === "outcome_pending"
            ? "消息仍在处理中，不要重复发送"
            : "发送结果未知，请点击失败消息确认"}
        </Text>
      )}
    </View>
  );
}
/** 操作面板组件：显示状态提示和操作按钮（如"接手处理"、"只读"等） */
function ActionPanel({
  title,
  details,
  action,
  tone,
  onPress,
  disabled,
  secondaryLabel,
  onSecondary,
}: {
  title: string;
  details?: string[];
  action?: string;
  tone: "primary" | "muted";
  onPress?: () => void;
  disabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>{title}</Text>
      {details?.length ? (
        <View style={styles.panelDetails}>
          {details.map((detail) => (
            <View key={detail} style={styles.panelDetailRow}>
              <View style={styles.panelDetailDot} />
              <Text numberOfLines={2} style={styles.panelDetailText}>
                {detail}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.panelActions}>
        {secondaryLabel && onSecondary ? (
          <Pressable
            accessibilityRole="button"
            onPress={onSecondary}
            style={({ pressed }) => [
              styles.panelButton,
              styles.panelButtonSecondary,
              pressed && styles.panelButtonPressed,
            ]}
          >
            <Text style={styles.panelButtonSecondaryText}>{secondaryLabel}</Text>
          </Pressable>
        ) : null}
        {action ? (
          <Pressable
            accessibilityRole="button"
            onPress={onPress}
            disabled={disabled || !onPress}
            style={({ pressed }) => [
              styles.panelButton,
              {
                backgroundColor: tone === "primary" ? colors.primary : colors.paper,
                borderWidth: tone === "primary" ? 0 : 1,
                borderColor: colors.rule,
              },
              pressed && onPress && styles.panelButtonPressed,
            ]}
          >
            <Text
              style={[
                styles.panelButtonText,
                { color: tone === "primary" ? colors.onPrimary : colors.muted },
              ]}
            >
              {action}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.canvas },
    keyboardArea: { flex: 1 },
    timelineArea: { flex: 1, position: "relative" },
    header: {
      backgroundColor: colors.canvas,
      minHeight: 56,
      paddingHorizontal: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 13,
    },
    headerControlPressed: { opacity: 0.55 },
    headerText: { flex: 1 },
    name: { color: colors.ink, fontSize: 17, fontWeight: "600" },
    company: { color: colors.muted, fontSize: 13, marginTop: 2 },
    headerStatus: { color: colors.blue, fontSize: 12, fontWeight: "500" },
    moreButton: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
    },
    chat: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28 },
    timelineHeader: { gap: 10, marginBottom: 12 },
    archivedDraftPanel: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.rule,
      backgroundColor: colors.paper,
    },
    archivedDraftTitle: { color: colors.ink, fontSize: 12, fontWeight: "700" },
    archivedDraftHint: { color: colors.muted, fontSize: 10, marginTop: 3 },
    archivedDraftText: {
      color: colors.ink,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 8,
    },
    archivedDraftAction: {
      color: colors.blue,
      fontSize: 11,
      fontWeight: "700",
      marginTop: 9,
    },
    timelineItem: { marginBottom: 12 },
    offlineBanner: {
      backgroundColor: colors.orangeWash,
      borderRadius: 14,
      padding: 13,
    },
    offlineTitle: { color: colors.navy, fontSize: 12, fontWeight: "800" },
    grabber: {
      width: 34,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.rule,
      alignSelf: "center",
      marginBottom: 16,
    },
    eventDotActive: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.blue,
    },
    eventText: { color: colors.muted, fontSize: 10 },
    collaborationPanel: {
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: 15,
      padding: 14,
      gap: 10,
      marginHorizontal: 16,
      marginTop: 8,
      shadowColor: colors.shadow,
      shadowOpacity: 0.12,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 3 },
      elevation: 3,
    },
    collaborationLabel: {
      color: colors.navy,
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.8,
    },
    collaborationRow: {
      borderTopWidth: 1,
      borderColor: colors.rule,
      paddingTop: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    collaborationRowPressed: { opacity: 0.55 },
    collaborationHint: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "700",
      paddingHorizontal: 6,
      paddingVertical: 4,
    },
    collaborationCopy: { flex: 1 },
    collaborationTitle: { color: colors.ink, fontSize: 12, fontWeight: "800" },
    collaborationStatus: { color: colors.muted, fontSize: 11, marginTop: 3 },
    collaborationReason: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 5,
    },
    collaborationButton: {
      backgroundColor: colors.orange,
      borderRadius: 12,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    collaborationButtonText: {
      color: colors.onPrimary,
      fontSize: 11,
      fontWeight: "800",
    },
    collaborationSecondaryButton: {
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: 16,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    collaborationSecondaryText: {
      color: colors.navy,
      fontSize: 11,
      fontWeight: "800",
    },
    modalHint: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 6,
    },
    responseInput: {
      minHeight: 120,
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: 12,
      marginTop: 14,
      padding: 12,
      color: colors.ink,
      textAlignVertical: "top",
    },
    modalActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 9,
      marginTop: 13,
    },
    modalCancel: { paddingHorizontal: 14, paddingVertical: 10 },
    modalCancelText: { color: colors.muted, fontWeight: "800", fontSize: 12 },
    modalConfirm: {
      backgroundColor: colors.primary,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 12,
    },
    modalConfirmText: { color: colors.onPrimary, fontWeight: "800", fontSize: 12 },
    composerDock: { backgroundColor: colors.paper },
    bottomDock: { backgroundColor: colors.paper },
    composerMeta: {
      minHeight: 24,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 9,
      paddingHorizontal: 4,
    },
    offlineDraft: {
      color: colors.muted,
      fontSize: 11,
      paddingHorizontal: 4,
      paddingBottom: 2,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.32)",
      justifyContent: "flex-end",
    },
    modalDismiss: { flex: 1 },
    briefingHeadline: {
      color: colors.ink,
      fontSize: 15,
      lineHeight: 22,
      marginBottom: 15,
    },
    menuDismiss: { flex: 1 },
    menuSheet: {
      maxHeight: "72%",
      backgroundColor: colors.paper,
      paddingHorizontal: 18,
      paddingTop: 9,
      paddingBottom: 30,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
    },
    menuActionRow: {
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 4,
    },
    menuActionRowPressed: { opacity: 0.65 },
    menuActionRowDisabled: { opacity: 0.4 },
    menuActionText: { color: colors.blue, fontSize: 14, fontWeight: "600" },
    menuActionHint: { color: colors.muted, fontSize: 11, marginTop: -3 },
    menuSectionLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.9,
      marginTop: 22,
      marginBottom: 12,
    },
    menuCollabRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    menuCollabCopy: { flex: 1 },
    menuCollabTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
    menuCollabStatus: { color: colors.muted, fontSize: 11, marginTop: 3 },
    menuCollabAction: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.rule,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    menuCollabActionDanger: {
      borderColor: colors.red,
      backgroundColor: colors.redWash,
    },
    menuCollabActionPressed: { opacity: 0.6 },
    menuCollabActionText: {
      color: colors.ink,
      fontSize: 11,
      fontWeight: "800",
    },
    menuCollabActionTextDanger: { color: colors.red },
    contactCardPressed: { opacity: 0.68 },
    contactAvatar: {
      width: 38,
      height: 38,
      borderRadius: 13,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    contactAvatarText: { color: colors.onPrimary, fontSize: 14, fontWeight: "800" },
    contactCopy: { flex: 1 },
    contactName: { color: colors.ink, fontSize: 14, fontWeight: "800" },
    contactCompany: { color: colors.muted, fontSize: 10, marginTop: 3 },
    profileBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.32)",
      justifyContent: "flex-end",
    },
    profileSheet: {
      height: "82%",
      backgroundColor: colors.paper,
      paddingHorizontal: 18,
      paddingTop: 9,
      paddingBottom: 28,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
    },
    profileHeadingCopy: { flex: 1, paddingRight: 18 },
    profileLoading: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
    profileLoadingText: {
      color: colors.muted,
      fontSize: 11,
      fontWeight: "700",
    },
    profileRetry: {
      color: colors.blue,
      fontSize: 11,
      fontWeight: "800",
      marginTop: 8,
    },
    profileIdentity: {
      flexDirection: "row",
      alignItems: "center",
      gap: 11,
      borderRadius: 15,
      backgroundColor: colors.canvas,
      padding: 13,
      marginTop: 18,
      marginBottom: 21,
    },
    profileLabel: {
      color: colors.ink,
      fontSize: 12,
      fontWeight: "700",
      marginTop: 18,
      marginBottom: 7,
    },
    profileNoteInput: {
      minHeight: 104,
      maxHeight: 160,
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: 14,
      backgroundColor: colors.paper,
      color: colors.ink,
      fontSize: 14,
      lineHeight: 20,
      padding: 12,
      textAlignVertical: "top",
    },
    profileCounter: {
      color: colors.muted,
      fontSize: 9,
      textAlign: "right",
      marginTop: 5,
      marginBottom: 18,
    },
    profileTagsInput: {
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: 13,
      color: colors.ink,
      fontSize: 14,
      paddingHorizontal: 12,
    },
    profileHint: { color: colors.muted, fontSize: 9, marginTop: 6 },
    profileError: {
      color: colors.red,
      fontSize: 10,
      fontWeight: "700",
      marginTop: 12,
    },
    profileSaved: {
      color: colors.green,
      fontSize: 10,
      fontWeight: "800",
      marginTop: 12,
    },
    profileSave: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 18,
      marginBottom: 12,
    },
    profileSaveDisabled: { opacity: 0.4 },
    profileSavePressed: { transform: [{ scale: 0.992 }], opacity: 0.84 },
    profileSaveText: { color: colors.onPrimary, fontSize: 13, fontWeight: "800" },
    menuEmpty: {
      borderRadius: 14,
      backgroundColor: colors.canvas,
      padding: 16,
    },
    menuEmptyTitle: { color: colors.ink, fontSize: 13, fontWeight: "800" },
    menuEmptyText: { color: colors.muted, fontSize: 11, marginTop: 4 },
    menuHistoryRow: {
      minHeight: 46,
      justifyContent: "center",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.rule,
    },
    menuHistoryText: { color: colors.blue, fontSize: 13, fontWeight: "600" },
    responseSheet: {
      backgroundColor: colors.paper,
      padding: 18,
      paddingBottom: 28,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
    },
    modalGrabber: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.rule,
      marginBottom: 3,
    },
    modalHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
    },
    modalTitle: { color: colors.ink, fontSize: 20, fontWeight: "800" },
    modalSub: { color: colors.muted, fontSize: 11, marginTop: 4 },
    modalClose: { color: colors.navy, fontSize: 12, fontWeight: "800" },
    reasonInput: {
      minHeight: 45,
      borderWidth: 1,
      borderColor: colors.rule,
      borderRadius: 11,
      paddingHorizontal: 11,
      color: colors.ink,
    },
    queueText: { flex: 1, gap: 3 },
    queueName: { color: colors.ink, fontSize: 14, fontWeight: "800" },
    queueDescription: { color: colors.muted, fontSize: 11 },
    assigneeAvatarText: { color: colors.ink, fontSize: 13, fontWeight: "800" },
    assigneeEmpty: {
      color: colors.muted,
      fontSize: 12,
      paddingVertical: 18,
      textAlign: "center",
    },
    loadOlder: {
      minHeight: 38,
      alignSelf: "center",
      borderRadius: 12,
      backgroundColor: colors.paper,
      paddingHorizontal: 13,
      alignItems: "center",
      justifyContent: "center",
      marginVertical: 3,
    },
    loadOlderPressed: { opacity: 0.65 },
    loadOlderContent: { flexDirection: "row", alignItems: "center", gap: 5 },
    loadOlderText: { color: colors.blue, fontSize: 10, fontWeight: "800" },
    olderError: {
      alignSelf: "center",
      paddingVertical: 7,
      paddingHorizontal: 10,
    },
    olderErrorText: { color: colors.orange, fontSize: 10, fontWeight: "700" },
    newMessages: {
      position: "absolute",
      alignSelf: "center",
      bottom: 12,
      minHeight: 38,
      borderRadius: 19,
      backgroundColor: colors.primary,
      paddingHorizontal: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      shadowColor: colors.shadow,
      shadowOpacity: 0.2,
      shadowRadius: 13,
      shadowOffset: { width: 0, height: 5 },
      elevation: 4,
    },
    newMessagesPressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
    newMessageDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: "colors.primary",
    },
    newMessagesText: { color: colors.onPrimary, fontSize: 11, fontWeight: "800" },
    date: {
      alignSelf: "center",
      color: colors.muted,
      fontSize: 10,
      fontWeight: "700",
      backgroundColor: colors.paper,
      borderRadius: 10,
      paddingHorizontal: 9,
      paddingVertical: 4,
      marginVertical: 5,
    },
    systemEvent: {
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      marginVertical: 5,
    },
    systemLine: { flex: 1, height: 1, backgroundColor: colors.rule },
    // 拍一拍：居中灰字提示，弱于聊天气泡
    patNotice: { alignItems: "center", marginVertical: 5 },
    patNoticeText: { color: colors.muted, fontSize: 11 },
    system: {
      alignSelf: "center",
      color: colors.muted,
      fontSize: 10,
      marginVertical: 2,
    },
    messageRow: { flexDirection: "row", alignItems: "flex-end", gap: 7 },
    left: { justifyContent: "flex-start" },
    right: { justifyContent: "flex-end" },
    bubble: {
      borderRadius: 17,
      paddingHorizontal: 13,
      paddingVertical: 10,
      maxWidth: "76%",
    },
    customer: {
      backgroundColor: colors.paper,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      borderTopLeftRadius: 5,
    },
    agent: { backgroundColor: colors.blueWash, borderTopRightRadius: 5 },
    me: { backgroundColor: colors.primary, borderTopRightRadius: 5 },
    messageAvatar: {
      width: 27,
      height: 27,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 1,
      overflow: "hidden",
    },
    messageAvatarImage: { width: 27, height: 27, borderRadius: 9 },
    messageAvatarCustomer: {
      backgroundColor: colors.paper,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    messageAvatarAgent: { backgroundColor: colors.blueWash },
    messageAvatarManual: { backgroundColor: colors.ink },
    messageAvatarText: { color: colors.paper, fontSize: 10, fontWeight: "700" },
    messageAvatarAgentText: { color: colors.blue, fontSize: 10, fontWeight: "800" },
    messageText: { color: colors.ink, fontSize: 14, lineHeight: 20 },
    messageImagePressed: { opacity: 0.82 },
    imageLoading: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.canvas,
    },
    imageHint: {
      position: "absolute",
      right: 7,
      bottom: 7,
      borderRadius: 9,
      backgroundColor: "rgba(18,57,68,0.84)",
      paddingHorizontal: 7,
      paddingVertical: 4,
    },
    imageHintText: { color: "white", fontSize: 10, fontWeight: "800" },
    imageFailure: {
      width: 220,
      minHeight: 116,
      borderRadius: 11,
      backgroundColor: colors.orangeWash,
      alignItems: "center",
      justifyContent: "center",
      padding: 14,
    },
    imageFailureAction: {
      color: colors.orange,
      fontSize: 9,
      fontWeight: "800",
      marginTop: 4,
    },
    meText: { color: colors.onPrimary },
    // 引用回复卡片
    quoteCard: {
      marginBottom: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderLeftWidth: 2,
      borderLeftColor: colors.muted,
      backgroundColor: colors.subtle,
      borderRadius: 4,
    },
    quoteAuthor: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.muted,
    },
    quoteText: {
      fontSize: 11,
      color: colors.muted,
    },
    // @提及高亮
    mentionText: { color: colors.primary, fontWeight: "600" },
    mentionTextOnDark: { color: "rgba(255,255,255,0.92)" },
    messageTime: {
      color: colors.muted,
      fontSize: 10,
      marginTop: 6,
      alignSelf: "flex-end",
    },
    messageTimeOnDark: { color: "rgba(255,255,255,0.78)" },
    // 初始加载：静态气泡形骨架（无动画，Motion 2 原则）
    skeletonList: { paddingVertical: 12, gap: 14 },
    skeletonRow: { alignItems: "flex-start" },
    skeletonRowOutbound: { alignItems: "flex-end" },
    skeletonBubble: {
      width: "68%",
      height: 44,
      borderRadius: 17,
      backgroundColor: colors.subtle,
    },
    loadError: { paddingVertical: 24, alignItems: "center", gap: 10 },
    loadErrorAction: {
      paddingHorizontal: 16,
      paddingVertical: 9,
      borderRadius: 10,
      backgroundColor: colors.subtle,
    },
    loadErrorActionPressed: { opacity: 0.8 },
    loadErrorActionText: { color: colors.blue, fontSize: 13, fontWeight: "700" },
    pending: { color: "rgba(255,255,255,0.78)", fontSize: 10, marginTop: 7 },
    composer: {
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 8,
      backgroundColor: colors.paper,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
      gap: 8,
    },
    characterCount: { color: colors.muted, fontSize: 10 },
    toolButtonPressed: { opacity: 0.6 },
    inputRow: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      borderRadius: 17,
      backgroundColor: colors.canvas,
      padding: 4,
    },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 112,
      paddingHorizontal: 4,
      paddingVertical: 0,
      color: colors.ink,
      // 单行：文字垂直居中，与 +/发送按钮对齐
      textAlignVertical: "center",
    },
    inputMultiline: {
      // 多行：顶对齐，避免文本块悬浮居中
      textAlignVertical: "top",
      paddingTop: 11,
      paddingBottom: 9,
    },
    send: {
      width: 40,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary,
      borderRadius: 12,
    },
    plusButton: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    sendDisabled: { opacity: 0.5 },
    sendPressed: { opacity: 0.8 },
    moreActions: {
      borderRadius: 15,
      backgroundColor: colors.canvas,
      padding: 6,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 4,
    },
    moreActionButton: {
      width: "48%",
      minHeight: 62,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
    },
    moreActionTitle: { color: colors.ink, fontSize: 10.5, fontWeight: "600" },
    panel: {
      backgroundColor: colors.paper,
      borderTopWidth: 1,
      borderColor: colors.rule,
      padding: 14,
      gap: 10,
    },
    panelTitle: { color: colors.muted, fontSize: 12, textAlign: "center" },
    panelDetails: { gap: 7, paddingVertical: 2 },
    panelDetailRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    panelDetailDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      marginTop: 6,
      backgroundColor: colors.blue,
    },
    panelDetailText: {
      flex: 1,
      color: colors.ink,
      fontSize: 11,
      lineHeight: 17,
    },
    panelButton: { flex: 1, padding: 14, borderRadius: 12, alignItems: "center" },
    panelButtonPressed: { opacity: 0.8 },
    panelButtonText: { fontSize: 14, fontWeight: "800" },
    panelActions: { flexDirection: "row", gap: 10, marginTop: 12 },
    panelButtonSecondary: { flex: 1, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.rule },
    panelButtonSecondaryText: { color: colors.blue, fontSize: 14, fontWeight: "700" },
    draftWarning: { color: colors.orange, fontSize: 10, fontWeight: "700" },
    draftStale: { gap: 4 },
    draftReview: { color: colors.navy, fontSize: 10, fontWeight: "800" },
    // 引用回复预览条
    replyPreview: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.canvas,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginBottom: 4,
      borderLeftWidth: 3,
      borderLeftColor: colors.primary,
    },
    replyPreviewContent: { flex: 1, gap: 1 },
    replyPreviewLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "700",
    },
    replyPreviewText: {
      color: colors.ink,
      fontSize: 12,
    },
    // 消息长按操作菜单
    messageMenuBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.32)",
      justifyContent: "flex-end",
    },
    messageMenuSheet: {
      backgroundColor: colors.paper,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 18,
      paddingTop: 12,
      paddingBottom: 28,
      gap: 4,
    },
    messageMenuTitle: {
      color: colors.muted,
      fontSize: 11,
      fontWeight: "600",
      marginBottom: 8,
      paddingHorizontal: 4,
    },
    messageMenuAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 4,
      borderRadius: 10,
    },
    messageMenuActionText: {
      color: colors.ink,
      fontSize: 14,
      fontWeight: "600",
    },
  });
