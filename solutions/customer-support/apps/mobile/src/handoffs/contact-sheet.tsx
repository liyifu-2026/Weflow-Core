/**
 * 联系人 Sheet（全屏 Modal）
 * 第一屏回答「这个人是谁 + 最近发生过什么」：资料摘要 + 关键统计 + 历史会话。
 * 提供拉黑/取消拉黑（黑名单：不建 Turn、不进会话列表、不推通知）与「前往对话」。
 * 点历史进入只读会话详情（无 Composer/无任何操作入口），关闭即回原会话。
 * 编辑资料通过 onRequestEdit 回调交给页面复用既有资料编辑弹窗。
 */
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "phosphor-react-native/src/icons/ArrowLeft";
import { CaretRight } from "phosphor-react-native/src/icons/CaretRight";
import { ChatCircleDots } from "phosphor-react-native/src/icons/ChatCircleDots";
import { CircleNotch } from "phosphor-react-native/src/icons/CircleNotch";
import { Prohibit } from "phosphor-react-native/src/icons/Prohibit";
import type { MobileSession } from "@/auth/session";
import {
  getContactProfile,
  getTranscript,
  listContactHistory,
  setContactBlocked,
  type ContactConversationSummary,
  type ContactProfile,
  type ServerMessage,
} from "@/conversations/api";
import { contactDisplayName } from "@/conversations/contact-profile";
import { MediaImage } from "@/media/media-image";
import { MediaViewerModal } from "@/media/media-viewer";
import { VoiceBubble } from "@/media/voice-bubble";
import { formatDay, formatTime } from "@/ui/format";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { uiTokens } from "@/ui/tokens";
import { UserAvatar } from "@/ui/user-avatar";

export function ContactSheet({
  visible,
  session,
  conversationId,
  initialLastHandlerName,
  initialLastHandlerAt,
  initialFirstContactAt,
  initialConversationCount,
  onClose,
  onRequestEdit,
  onNavigateToConversation,
}: {
  visible: boolean;
  session: MobileSession;
  conversationId: string;
  /** 联系人列表聚合带来的统计初值（进入即显示，避免空等） */
  initialLastHandlerName?: string | null;
  initialLastHandlerAt?: string | null;
  initialFirstContactAt?: string | null;
  initialConversationCount?: number | null;
  onClose: () => void;
  onRequestEdit: (profile: ContactProfile) => void;
  onNavigateToConversation?: (conversationId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [profile, setProfile] = useState<ContactProfile>();
  const [history, setHistory] = useState<ContactConversationSummary[]>([]);
  const [error, setError] = useState<string>();
  const [openedConversation, setOpenedConversation] = useState<{
    conversationId: string;
    name: string;
  }>();
  const [showingAll, setShowingAll] = useState(false);
  const [allCursor, setAllCursor] = useState<string | null>(null);
  const [blocking, setBlocking] = useState(false);
  /** 最近一次人工处理人（联系人列表聚合数据，进入时一次性拉取） */
  const [lastHandler, setLastHandler] = useState<{
    name: string | null;
    at: string | null;
  }>({
    name: initialLastHandlerName ?? null,
    at: initialLastHandlerAt ?? null,
  });
  const [firstContactAt, setFirstContactAt] = useState<string | null>(
    initialFirstContactAt ?? null,
  );
  const [conversationCount, setConversationCount] = useState<number | null>(
    initialConversationCount ?? null,
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      let loadedProfile: ContactProfile | undefined;
      try {
        loadedProfile = await getContactProfile(session, conversationId);
        if (!active) return;
        setProfile(loadedProfile);
        setError(undefined);
      } catch {
        if (active) setError("联系人资料暂时无法加载，请稍后重试。");
        return;
      }
      // 历史对话加载失败不影响资料展示
      if (!loadedProfile) return;
      try {
        const page = await listContactHistory(
          session,
          loadedProfile.contactId,
          undefined,
          10,
        );
        if (!active) return;
        setHistory(page.conversations);
        setAllCursor(page.nextCursor);
      } catch {
        // 历史加载失败静默处理，资料区仍可展示
      }
    })();
    return () => {
      active = false;
    };
  }, [visible, session, conversationId]);

  /** 拉黑 / 取消拉黑：写审计；拉黑后该会话从会话列表消失 */
  async function toggleBlocked() {
    if (!session || !profile || blocking) return;
    const next = !profile.blocked;
    const confirmed = await new Promise<boolean>((resolve) => {
      Alert.alert(
        next ? "拉黑该联系人？" : "取消拉黑？",
        next
          ? "拉黑后：AI 不再自动回复，会话从会话列表隐藏，不再推送通知；消息仍会入库，可在联系人页查看历史。"
          : "取消拉黑后该联系人恢复正常会话展示与 AI 接待。",
        [
          { text: "取消", style: "cancel", onPress: () => resolve(false) },
          {
            text: next ? "拉黑" : "取消拉黑",
            style: next ? "destructive" : "default",
            onPress: () => resolve(true),
          },
        ],
      );
    });
    if (!confirmed) return;
    setBlocking(true);
    try {
      await setContactBlocked(session, conversationId, next);
      setProfile({ ...profile, blocked: next });
    } catch {
      Alert.alert("操作失败", "请检查网络后重试。");
    } finally {
      setBlocking(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.page}>
        {openedConversation ? (
          <ReadOnlyConversation
            session={session}
            conversationId={openedConversation.conversationId}
            name={openedConversation.name}
            onBack={() => setOpenedConversation(undefined)}
          />
        ) : showingAll ? (
          <AllHistory
            session={session}
            contactId={profile?.contactId}
            name={profile ? displayName(profile) : "联系人"}
            currentConversationId={conversationId}
            initial={history}
            initialCursor={allCursor}
            onOpen={(item) =>
              setOpenedConversation({
                conversationId: item.conversationId,
                name: profile ? displayName(profile) : "联系人",
              })
            }
            onBack={() => setShowingAll(false)}
          />
        ) : (
          <>
            <View style={styles.header}>
              <Pressable
                accessibilityLabel="关闭联系人"
                hitSlop={12}
                onPress={onClose}
                style={styles.headerButton}
              >
                <ArrowLeft size={23} color={colors.ink} />
              </Pressable>
              <Text style={styles.headerTitle}>联系人</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="编辑联系人资料"
                hitSlop={12}
                disabled={!profile}
                onPress={() => {
                  if (profile) onRequestEdit(profile);
                }}
                style={styles.headerButton}
              >
                <Text
                  style={[
                    styles.editText,
                    !profile && styles.editTextDisabled,
                  ]}
                >
                  编辑
                </Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.content}>
              {error ? (
                <Text style={styles.error}>{error}</Text>
              ) : !profile ? (
                <View style={styles.loading}>
                  <ActivityIndicator color={colors.blue} />
                </View>
              ) : (
                <>
                  <View style={styles.profileBlock}>
                    <UserAvatar
                      contactId={profile.contactId}
                      fallbackName={displayName(profile)}
                      sessionToken={session.sessionToken}
                      size={52}
                    />
                    <Text style={styles.name}>{displayName(profile)}</Text>
                    {profile.channelRemark ? (
                      <Text style={styles.meta}>{profile.channelRemark}</Text>
                    ) : null}
                    {/* 身份徽标：AI 接待 / 仅人工 / 已拉黑 */}
                    <View style={styles.badgeRow}>
                      {profile.blocked ? (
                        <View style={[styles.badge, styles.badgeBlocked]}>
                          <Text style={styles.badgeBlockedText}>已拉黑</Text>
                        </View>
                      ) : profile.agentEnabled ? (
                        <View style={[styles.badge, styles.badgeAgent]}>
                          <Text style={styles.badgeAgentText}>AI 接待中</Text>
                        </View>
                      ) : (
                        <View style={[styles.badge, styles.badgeHuman]}>
                          <Text style={styles.badgeHumanText}>仅人工处理</Text>
                        </View>
                      )}
                    </View>
                    {/* 关键统计：首末联系 / 会话数 / 最近处理人 */}
                    <View style={styles.statsRow}>
                      {typeof conversationCount === "number" ? (
                        <StatCell label="会话" value={String(conversationCount)} />
                      ) : null}
                      {firstContactAt ? (
                        <StatCell
                          label="首次联系"
                          value={formatDay(firstContactAt)}
                        />
                      ) : null}
                      {profile.updatedAt ? (
                        <StatCell
                          label="资料更新"
                          value={formatDay(profile.updatedAt)}
                        />
                      ) : null}
                    </View>
                    {lastHandler?.name ? (
                      <Text style={styles.lastHandler}>
                        最近由 {lastHandler.name} 人工处理
                        {lastHandler.at ? ` · ${formatDay(lastHandler.at)}` : ""}
                      </Text>
                    ) : null}
                    {/* 原始昵称 vs 共享别名对照 */}
                    {profile.sharedAlias &&
                    (profile.channelDisplayName || profile.channelNickname) ? (
                      <Text style={styles.aliasNote}>
                        微信名：{profile.channelDisplayName || profile.channelNickname}
                        {profile.channelNickname &&
                        profile.channelNickname !== profile.channelDisplayName
                          ? `（昵称 ${profile.channelNickname}）`
                          : ""}
                      </Text>
                    ) : null}
                    {profile.note ? (
                      <View style={styles.fieldBlock}>
                        <Text style={styles.fieldLabel}>备注</Text>
                        <Text style={styles.fieldText}>{profile.note}</Text>
                      </View>
                    ) : null}
                    {profile.tags.length ? (
                      <View style={styles.fieldBlock}>
                        <Text style={styles.fieldLabel}>标签</Text>
                        <View style={styles.tagRow}>
                          {profile.tags.map((tag) => (
                            <View key={tag} style={styles.tag}>
                              <Text style={styles.tagText}>{tag}</Text>
                            </View>
                          ))}
                        </View>
                      </View>
                    ) : null}
                    {onNavigateToConversation ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="前往对话"
                        onPress={() => onNavigateToConversation(conversationId)}
                        style={({ pressed }) => [
                          styles.goToConversationButton,
                          pressed && styles.goToConversationButtonPressed,
                        ]}
                      >
                        <ChatCircleDots size={18} color={colors.onPrimary} />
                        <Text style={styles.goToConversationText}>前往对话</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={profile.blocked ? "取消拉黑" : "拉黑联系人"}
                      disabled={blocking}
                      onPress={() => void toggleBlocked()}
                      style={({ pressed }) => [
                        styles.blockButton,
                        profile.blocked && styles.unblockButton,
                        pressed && !blocking && styles.blockButtonPressed,
                        blocking && styles.blockButtonDisabled,
                      ]}
                    >
                      {blocking ? (
                        <CircleNotch size={17} color={colors.red} />
                      ) : (
                        <Prohibit
                          size={17}
                          color={profile.blocked ? colors.ink : colors.red}
                        />
                      )}
                      <Text
                        style={[
                          styles.blockButtonText,
                          { color: profile.blocked ? colors.ink : colors.red },
                        ]}
                      >
                        {profile.blocked ? "取消拉黑" : "拉黑"}
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={styles.sectionLabel}>历史对话</Text>
                  {history.length === 0 ? (
                    <Text style={styles.empty}>暂无历史会话</Text>
                  ) : (
                    history.map((item) => (
                      <Pressable
                        key={item.conversationId}
                        accessibilityRole="button"
                        accessibilityLabel={`查看历史会话 ${item.conversationId}`}
                        onPress={() =>
                          setOpenedConversation({
                            conversationId: item.conversationId,
                            name: displayName(profile),
                          })
                        }
                        style={({ pressed }) => [
                          styles.historyRow,
                          pressed && styles.rowPressed,
                        ]}
                      >
                        <View style={styles.historyCopy}>
                          <Text style={styles.historyText} numberOfLines={1}>
                            {item.latestMessageText || "（无消息）"}
                          </Text>
                          <Text style={styles.historyMeta}>
                            {item.conversationId === conversationId
                              ? "当前会话"
                              : handoffStatusCopy(item.handoffStatus)}
                            {item.latestMessageAt
                              ? ` · ${formatTime(item.latestMessageAt)}`
                              : ""}
                          </Text>
                        </View>
                        <CaretRight size={16} color={colors.blue} />
                      </Pressable>
                    ))
                  )}
                  {history.length > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="查看全部历史"
                      onPress={() => setShowingAll(true)}
                      style={({ pressed }) => [
                        styles.allHistoryRow,
                        pressed && styles.rowPressed,
                      ]}
                    >
                      <Text style={styles.allHistoryText}>查看全部历史</Text>
                      <CaretRight size={16} color={colors.blue} />
                    </Pressable>
                  ) : null}
                </>
              )}
            </ScrollView>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

/** 联系人完整历史（游标分页，按最近消息倒序） */
function AllHistory({
  session,
  contactId,
  name,
  currentConversationId,
  initial,
  initialCursor,
  onOpen,
  onBack,
}: {
  session: MobileSession;
  contactId?: string;
  name: string;
  currentConversationId: string;
  initial: ContactConversationSummary[];
  initialCursor: string | null;
  onOpen: (item: ContactConversationSummary) => void;
  onBack: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string>();

  const loadMore = async () => {
    if (!contactId || !cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(undefined);
    try {
      const page = await listContactHistory(session, contactId, cursor);
      setItems((current) => [...current, ...page.conversations]);
      setCursor(page.nextCursor);
    } catch {
      setLoadError("加载失败，请重试。");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回联系人"
          hitSlop={12}
          onPress={onBack}
          style={styles.headerButton}
        >
          <ArrowLeft size={23} color={colors.ink} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>{name}</Text>
          <Text style={styles.readOnlyTag}>历史对话</Text>
        </View>
        <View style={styles.headerButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {items.length === 0 ? (
          <Text style={styles.empty}>暂无历史会话</Text>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.conversationId}
              accessibilityRole="button"
              accessibilityLabel={`查看历史会话 ${item.conversationId}`}
              onPress={() => onOpen(item)}
              style={({ pressed }) => [
                styles.historyRow,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={styles.historyCopy}>
                <Text style={styles.historyText} numberOfLines={1}>
                  {item.latestMessageText || "（无消息）"}
                </Text>
                <Text style={styles.historyMeta}>
                  {item.conversationId === currentConversationId
                    ? "当前会话"
                    : item.handoffStatus
                      ? "人工处理"
                      : "Agent 自动处理"}
                  {item.latestMessageAt
                    ? ` · ${formatDay(item.latestMessageAt)} ${formatTime(item.latestMessageAt)}`
                    : ""}
                </Text>
              </View>
              <CaretRight size={16} color={colors.blue} />
            </Pressable>
          ))
        )}
        {cursor ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="加载更多历史"
            disabled={loadingMore}
            onPress={() => void loadMore()}
            style={styles.loadMoreRow}
          >
            {loadingMore ? (
              <ActivityIndicator size="small" color={colors.blue} />
            ) : (
              <Text style={styles.loadMoreText}>
                {loadError ?? "加载更多"}
              </Text>
            )}
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** 只读历史会话详情：无 Composer、无任何操作入口 */
function ReadOnlyConversation({
  session,
  conversationId,
  name,
  onBack,
}: {
  session: MobileSession;
  conversationId: string;
  name: string;
  onBack: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [messages, setMessages] = useState<ServerMessage[]>();
  const [error, setError] = useState<string>();
  const [lightboxMediaId, setLightboxMediaId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getTranscript(session, conversationId)
      .then((page) => {
        if (active) setMessages(page.messages);
      })
      .catch(() => {
        if (active) setError("历史会话暂时无法加载。");
      });
    return () => {
      active = false;
    };
  }, [session, conversationId]);

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="返回联系人"
          hitSlop={12}
          onPress={onBack}
          style={styles.headerButton}
        >
          <ArrowLeft size={23} color={colors.ink} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerTitle}>{name}</Text>
          <Text style={styles.readOnlyTag}>历史记录 · 只读</Text>
        </View>
        <View style={styles.headerButton} />
      </View>
      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : !messages ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.blue} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.transcript}>
          {messages.length === 0 ? (
            <Text style={styles.empty}>暂无消息</Text>
          ) : (
            messages.map((message) => (
              <View
                key={message.messageId}
                style={[
                  styles.messageRow,
                  message.direction === "outbound"
                    ? styles.messageRowOutbound
                    : undefined,
                ]}
              >
                <View
                  style={[
                    styles.messageBubble,
                    message.direction === "outbound"
                      ? styles.messageBubbleOutbound
                      : undefined,
                  ]}
                >
                  {message.contentType === "image" && message.mediaId ? (
                    <MediaImage
                      session={session}
                      mediaId={message.mediaId}
                      offline={false}
                      style={styles.historyImage}
                      onOpen={() => setLightboxMediaId(message.mediaId ?? null)}
                    />
                  ) : message.contentType === "voice" && message.mediaId ? (
                    <VoiceBubble
                      session={session}
                      mediaId={message.mediaId}
                      offline={false}
                    />
                  ) : message.contentType !== "text" ? (
                    <Text style={styles.messageNonText}>[文件]</Text>
                  ) : (
                    <Text style={styles.messageText}>{message.text}</Text>
                  )}
                  <Text style={styles.messageTime}>
                    {formatTime(message.occurredAt)}
                  </Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}
      {lightboxMediaId ? (
        <MediaViewerModal
          session={session}
          mediaId={lightboxMediaId}
          onClose={() => setLightboxMediaId(null)}
        />
      ) : null}
    </View>
  );
}

function displayName(profile: ContactProfile): string {
  return contactDisplayName(profile);
}

/** 统计小单元：数值 + 灰色小标签 */
function StatCell({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function handoffStatusCopy(status: string | null): string {
  if (!status) return "Agent 处理";
  if (status === "in_progress") return "人工处理";
  return "已结束";
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.canvas },
    header: {
      minHeight: 52,
      paddingHorizontal: 12,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    headerButton: {
      minWidth: 38,
      minHeight: 38,
      alignItems: "center",
      justifyContent: "center",
    },
    headerTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
    headerCopy: { alignItems: "center" },
    readOnlyTag: { color: colors.muted, fontSize: 11, marginTop: 2 },
    editText: { color: colors.blue, fontSize: 14, fontWeight: "600" },
    editTextDisabled: { opacity: 0.4 },
    content: { padding: 20, paddingBottom: 42 },
    loading: { paddingVertical: 60, alignItems: "center" },
    error: { color: colors.red, fontSize: 13, paddingVertical: 24 },
    profileBlock: { alignItems: "flex-start", gap: 4, marginBottom: 26 },
    name: { color: colors.ink, fontSize: 19, fontWeight: "700" },
    meta: { color: colors.muted, fontSize: 13 },
    fieldBlock: { marginTop: 10, alignSelf: "stretch" },
    fieldLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "600",
      marginBottom: 4,
    },
    fieldText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
    tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    tag: {
      backgroundColor: colors.blueWash,
      borderRadius: 8,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    tagText: { color: colors.blue, fontSize: 11, fontWeight: "600" },
    sectionLabel: {
      color: colors.muted,
      fontSize: 12,
      fontWeight: "700",
      marginBottom: 8,
    },
    empty: { color: colors.muted, fontSize: 13, paddingVertical: 18 },
    historyRow: {
      minHeight: 58,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.rule,
    },
    rowPressed: { backgroundColor: colors.subtle },
    historyCopy: { flex: 1 },
    historyText: { color: colors.ink, fontSize: 13 },
    historyMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
    allHistoryRow: {
      minHeight: 50,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 6,
    },
    allHistoryText: { color: colors.blue, fontSize: 13, fontWeight: "600" },
    loadMoreRow: {
      minHeight: 48,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 8,
    },
    loadMoreText: { color: colors.blue, fontSize: 13, fontWeight: "600" },
    transcript: { padding: 16, gap: 8 },
    messageRow: { alignItems: "flex-start" },
    messageRowOutbound: { alignItems: "flex-end" },
    messageBubble: {
      maxWidth: "82%",
      backgroundColor: colors.paper,
      borderRadius: uiTokens.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.rule,
    },
    messageBubbleOutbound: { backgroundColor: colors.blueWash },
    messageText: { color: colors.ink, fontSize: 13, lineHeight: 19 },
    historyImage: { width: 160, height: 160 },
    messageNonText: { color: colors.muted, fontSize: 12 },
    messageTime: { color: colors.muted, fontSize: 10, marginTop: 4 },
    goToConversationButton: {
      marginTop: 18,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: uiTokens.radius.md,
      paddingHorizontal: 20,
      paddingVertical: 12,
      alignSelf: "stretch",
    },
    goToConversationButtonPressed: { opacity: 0.85 },
    goToConversationText: {
      color: colors.onPrimary,
      fontSize: 15,
      fontWeight: "700",
    },
    // 身份徽标
    badgeRow: { flexDirection: "row", gap: 6, marginTop: 8 },
    badge: {
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 3,
    },
    badgeAgent: { backgroundColor: colors.blueWash },
    badgeAgentText: { color: colors.blue, fontSize: 11, fontWeight: "700" },
    badgeHuman: { backgroundColor: colors.subtle },
    badgeHumanText: { color: colors.ink, fontSize: 11, fontWeight: "700" },
    badgeBlocked: { backgroundColor: colors.redWash },
    badgeBlockedText: { color: colors.red, fontSize: 11, fontWeight: "700" },
    // 关键统计
    statsRow: {
      flexDirection: "row",
      gap: 22,
      marginTop: 14,
      alignSelf: "flex-start",
    },
    statCell: { alignItems: "center", minWidth: 56 },
    statValue: { color: colors.ink, fontSize: 15, fontWeight: "700" },
    statLabel: { color: colors.muted, fontSize: 10, marginTop: 2 },
    lastHandler: { color: colors.muted, fontSize: 12, marginTop: 12 },
    aliasNote: { color: colors.muted, fontSize: 11, marginTop: 4 },
    // 拉黑按钮
    blockButton: {
      marginTop: 14,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderWidth: 1,
      borderColor: colors.red,
      borderRadius: uiTokens.radius.md,
      paddingVertical: 11,
    },
    unblockButton: { borderColor: colors.rule },
    blockButtonPressed: { opacity: 0.7 },
    blockButtonDisabled: { opacity: 0.45 },
    blockButtonText: { fontSize: 14, fontWeight: "700" },
  });
