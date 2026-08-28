/**
 * 微信式工作首页：左右滑动两页（会话 | 联系人）。
 * 会话页：全部可见会话按性质分组——颜色点与卡片底色区分、上下顺序即优先级；
 * 分组可折叠（极简折叠条：色点 + 计数 + 箭头，无文字）。
 */
import { router } from "expo-router";
import { CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CaretUp } from "phosphor-react-native/src/icons/CaretUp";
import { MagnifyingGlass } from "phosphor-react-native/src/icons/MagnifyingGlass";
import { X } from "phosphor-react-native/src/icons/X";
import * as Crypto from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { actionErrorCopy } from "@/api/action-error-copy";
import { apiBaseUrl } from "@/api/config";
import { loadSession, type MobileSession } from "@/auth/session";
import {
  acceptHandoff,
  contactDisplayName,
  listContacts,
  setConversationHidden,
  takeOverHandoff,
  type ContactListRow,
} from "@/conversations/api";
import type { ConversationPreview } from "@/conversations/model";
import { useConversationList } from "@/conversations/use-conversation-list";
import { ContactSheet } from "@/handoffs/contact-sheet";
import { LoadState } from "@/ui/load-state";
import type { ThemeColors } from "@/ui/theme";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { UserAvatar } from "@/ui/user-avatar";
import { uiTokens } from "@/ui/tokens";

type GroupTone = "orange" | "blue" | "gray" | "none";

export default function HandoffInboxScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { width: windowWidth } = useWindowDimensions();
  const {
    conversations,
    loading,
    refreshing,
    error,
    refresh,
    offline,
    capabilities,
  } = useConversationList();
  const [page, setPage] = useState<0 | 1>(0);
  const pagerRef = useRef<ScrollView>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [session, setSession] = useState<MobileSession | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sheetRow, setSheetRow] = useState<ContactListRow | null>(null);

  useEffect(() => {
    void loadSession().then((loaded) => {
      if (loaded) setSession(loaded);
    });
  }, []);

  // 会话分组（顺序即优先级：需要处理 → 我处理中 → Agent 处理中 → 普通会话）
  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const rows = needle
      ? conversations.filter((item) =>
          [item.name, item.preview].some((value) =>
            value.toLocaleLowerCase("zh-CN").includes(needle),
          ),
        )
      : conversations;
    if (needle) {
      return [
        { key: "search", tone: "none" as GroupTone, data: rows },
      ];
    }
    const need = rows.filter(
      (item) => item.state === "pending" || item.state === "transfer_target",
    );
    const mine = rows.filter((item) => item.state === "mine");
    const agent = rows.filter((item) => item.state === "agent");
    const quiet = rows.filter(
      (item) => item.state === "resolved" || item.state === "other",
    );
    const out: { key: string; tone: GroupTone; data: ConversationPreview[] }[] = [];
    if (need.length) out.push({ key: "need", tone: "orange", data: need });
    if (mine.length) out.push({ key: "mine", tone: "blue", data: mine });
    if (agent.length) out.push({ key: "agent", tone: "gray", data: agent });
    if (quiet.length) out.push({ key: "quiet", tone: "none", data: quiet });
    return out;
  }, [conversations, query]);

  const inboxAvailable = capabilities.mobileHandoffInbox;

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function onPagerScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const offset = event.nativeEvent.contentOffset.x;
    const next = offset >= windowWidth * 0.5 ? 1 : 0;
    if (next !== page) setPage(next as 0 | 1);
  }

  function switchPage(next: 0 | 1) {
    setPage(next);
    pagerRef.current?.scrollTo({ x: next * windowWidth, animated: true });
  }

  function quickActionFailed(reason: unknown) {
    const copy = actionErrorCopy(
      reason instanceof Error && "code" in reason
        ? {
            code: (reason as { code?: string }).code ?? "request_failed",
            status: (reason as { status?: number }).status ?? 0,
          }
        : undefined,
    );
    Alert.alert("操作未完成", copy.message || "状态可能已变化，请下拉刷新。");
  }

  async function quickClaim(item: ConversationPreview) {
    if (busyId || !session) return;
    setBusyId(item.id);
    try {
      await acceptHandoff(session, item.id, Crypto.randomUUID(), item.handoffRevision);
      await refresh(true);
    } catch (reason) {
      quickActionFailed(reason);
      await refresh(true);
    } finally {
      setBusyId(null);
    }
  }

  async function quickTakeover(item: ConversationPreview) {
    if (busyId || !session) return;
    setBusyId(item.id);
    try {
      await takeOverHandoff(session, item.id, Crypto.randomUUID());
      await refresh(true);
    } catch (reason) {
      quickActionFailed(reason);
      await refresh(true);
    } finally {
      setBusyId(null);
    }
  }

  async function quickHide(item: ConversationPreview) {
    if (busyId || !session) return;
    setBusyId(item.id);
    try {
      await setConversationHidden(session, item.id, true);
      await refresh(true);
    } catch (reason) {
      quickActionFailed(reason);
    } finally {
      setBusyId(null);
    }
  }

  function quickHandback(item: ConversationPreview) {
    router.push(`/conversation/${item.id}?finish=1`);
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
      <View style={styles.header}>
        {searchOpen ? (
          <View style={styles.searchBox}>
            <MagnifyingGlass color={colors.muted} size={18} />
            <TextInput
              autoFocus
              accessibilityLabel="搜索会话"
              onChangeText={setQuery}
              placeholder="搜索"
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
              value={query}
            />
            <Pressable
              accessibilityLabel="关闭搜索"
              hitSlop={8}
              onPress={() => {
                setSearchOpen(false);
                setQuery("");
              }}
            >
              <X color={colors.ink} size={20} />
            </Pressable>
          </View>
        ) : (
          <View style={styles.headerTopline}>
            <View style={styles.headerTabs}>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: page === 0 }}
                onPress={() => switchPage(0)}
                hitSlop={6}
              >
                <Text style={[styles.tabTitle, page === 0 && styles.tabTitleActive]}>
                  会话
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: page === 1 }}
                onPress={() => switchPage(1)}
                hitSlop={6}
              >
                <Text style={[styles.tabTitle, page === 1 && styles.tabTitleActive]}>
                  联系人
                </Text>
              </Pressable>
            </View>
            <View style={styles.headerActions}>
              {inboxAvailable ? (
                <Pressable
                  accessibilityLabel="搜索会话"
                  hitSlop={8}
                  onPress={() => setSearchOpen(true)}
                  style={styles.iconButton}
                >
                  <MagnifyingGlass color={colors.ink} size={21} />
                </Pressable>
              ) : null}
              <Pressable
                accessibilityLabel="打开个人面板"
                hitSlop={8}
                onPress={() => router.push("/me")}
                style={styles.avatarButton}
              >
                {session?.user.avatarUrl ? (
                  <Image
                    source={{
                      uri: `${apiBaseUrl}${session.user.avatarUrl}`,
                      headers: { authorization: `Bearer ${session.sessionToken}` },
                    }}
                    style={styles.avatar}
                  />
                ) : (
                  <View style={styles.avatarFallback}>
                    <Text style={styles.avatarFallbackText}>
                      {(
                        session?.user.displayName ||
                        session?.user.username ||
                        "客"
                      )
                        .slice(0, 1)
                        .toUpperCase()}
                    </Text>
                  </View>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {offline ? (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerText}>离线 · 显示最近记录</Text>
        </View>
      ) : null}

      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onPagerScrollEnd}
      >
        <View style={{ width: windowWidth }}>
          <ConversationsPage
            groups={groups}
            collapsed={collapsed}
            onToggleGroup={toggleGroup}
            loading={loading}
            error={error}
            refreshing={refreshing}
            onRefresh={() => void refresh(true)}
            inboxAvailable={inboxAvailable}
            hasQuery={Boolean(query.trim())}
            sessionToken={session?.sessionToken}
            busyId={busyId}
            onOpen={(item) => router.push(`/conversation/${item.id}`)}
            onClaim={(item) => void quickClaim(item)}
            onTakeover={(item) => void quickTakeover(item)}
            onHide={(item) => void quickHide(item)}
            onHandback={(item) => quickHandback(item)}
          />
        </View>
        <View style={{ width: windowWidth }}>
          <ContactsPage
            session={session}
            onOpen={(row) => setSheetRow(row)}
          />
        </View>
      </ScrollView>

      {session ? (
        <ContactSheet
          visible={Boolean(sheetRow)}
          session={session}
          conversationId={sheetRow?.conversationId ?? ""}
          initialLastHandlerName={sheetRow?.lastHandlerName ?? null}
          initialLastHandlerAt={sheetRow?.lastHandlerAt ?? null}
          initialFirstContactAt={sheetRow?.firstContactAt ?? null}
          initialConversationCount={sheetRow?.conversationCount ?? null}
          onClose={() => setSheetRow(null)}
          onRequestEdit={() => undefined}
          onNavigateToConversation={(conversationId) => {
            setSheetRow(null);
            router.push(`/conversation/${conversationId}`);
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** 会话页：分组折叠 + 分色卡片 + 左滑动作 */
function ConversationsPage(props: {
  groups: { key: string; tone: GroupTone; data: ConversationPreview[] }[];
  collapsed: Set<string>;
  onToggleGroup: (key: string) => void;
  loading: boolean;
  error?: string;
  refreshing: boolean;
  onRefresh: () => void;
  inboxAvailable: boolean;
  hasQuery: boolean;
  sessionToken?: string;
  busyId: string | null;
  onOpen: (item: ConversationPreview) => void;
  onClaim: (item: ConversationPreview) => void;
  onTakeover: (item: ConversationPreview) => void;
  onHide: (item: ConversationPreview) => void;
  onHandback: (item: ConversationPreview) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const sections = props.groups.map((group) => ({
    ...group,
    data: props.collapsed.has(group.key) ? [] : group.data,
  }));
  return (
    <FlatList
      data={sections}
      keyExtractor={(section) => section.key}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={props.refreshing}
          onRefresh={props.onRefresh}
          tintColor={colors.primary}
        />
      }
      renderItem={({ item: group }) => (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${groupTitle(group.key)} ${group.data.length} 个会话`}
            onPress={() => props.onToggleGroup(group.key)}
            style={({ pressed }) => [
              styles.groupBar,
              pressed && styles.groupBarPressed,
            ]}
          >
            <View
              style={[
                styles.groupDot,
                group.tone === "orange" && styles.groupDotOrange,
                group.tone === "blue" && styles.groupDotBlue,
                group.tone === "gray" && styles.groupDotGray,
                group.tone === "none" && styles.groupDotNone,
              ]}
            />
            <Text style={styles.groupTitle}>{groupTitle(group.key)}</Text>
            <Text style={styles.groupCount}>{group.data.length}</Text>
            {props.collapsed.has(group.key) ? (
              <CaretDown size={14} color={colors.muted} />
            ) : (
              <CaretUp size={14} color={colors.muted} />
            )}
          </Pressable>
          {group.data.map((item, index) => (
            <InboxRow
              key={item.id}
              item={item}
              tone={group.tone}
              last={index === group.data.length - 1}
              busy={props.busyId === item.id}
              sessionToken={props.sessionToken}
              onPress={() => props.onOpen(item)}
              onClaim={() => props.onClaim(item)}
              onTakeover={() => props.onTakeover(item)}
              onHide={() => props.onHide(item)}
              onHandback={() => props.onHandback(item)}
            />
          ))}
        </View>
      )}
      ListEmptyComponent={
        props.loading ? (
          <LoadState kind="loading" title="正在读取" />
        ) : props.error ? (
          <LoadState
            kind="error"
            title="暂时无法读取"
            actionLabel="重新加载"
            onAction={props.onRefresh}
          />
        ) : !props.inboxAvailable ? (
          <LoadState
            kind="empty"
            title="人工接管暂不可用"
            description="当前环境尚未开放此能力。"
          />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {props.hasQuery ? "没有找到相关会话" : "暂无会话"}
            </Text>
          </View>
        )
      }
      showsVerticalScrollIndicator={false}
    />
  );
}

/** 联系人页：微信式通讯录 */
function ContactsPage({
  session,
  onOpen,
}: {
  session: MobileSession | null;
  onOpen: (row: ContactListRow) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [rows, setRows] = useState<ContactListRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setRows((await listContacts(session)).contacts);
    } catch {
      // 静默；下拉重试
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.contactId}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void load()} />
      }
      renderItem={({ item, index }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${contactDisplayName(item)}，${item.latestMessageText}`}
          onPress={() => onOpen(item)}
          style={({ pressed }) => [
            styles.contactRow,
            index !== rows.length - 1 && styles.rowDivider,
            pressed && styles.rowPressed,
          ]}
        >
          <UserAvatar
            contactId={item.contactId}
            fallbackName={contactDisplayName(item)}
            sessionToken={session?.sessionToken ?? ""}
            size={40}
          />
          <View style={styles.contactCopy}>
            <Text numberOfLines={1} style={styles.contactName}>
              {contactDisplayName(item)}
            </Text>
            <Text numberOfLines={1} style={styles.contactPreview}>
              {item.latestMessageText || "暂无消息"}
            </Text>
          </View>
        </Pressable>
      )}
      ListEmptyComponent={
        loading ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>正在读取</Text>
          </View>
        ) : (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>暂无联系人</Text>
          </View>
        )
      }
      showsVerticalScrollIndicator={false}
    />
  );
}

/** 左滑动作（按状态 2 个：主动作 + 隐藏） */
function InboxRow({
  item,
  tone,
  last,
  busy,
  sessionToken,
  onPress,
  onClaim,
  onTakeover,
  onHide,
  onHandback,
}: {
  item: ConversationPreview;
  tone: GroupTone;
  last: boolean;
  busy: boolean;
  sessionToken?: string;
  onPress: () => void;
  onClaim: () => void;
  onTakeover: () => void;
  onHide: () => void;
  onHandback: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const needClaim = item.state === "pending" || item.state === "transfer_target";
  const isMine = item.state === "mine";
  const canTakeover = item.state === "agent";
  // resolved/other（普通会话）无主动作，仅保留「隐藏」
  const primaryAction = needClaim ? onClaim : isMine ? onHandback : canTakeover ? onTakeover : undefined;
  const primaryLabel = needClaim ? "接手" : isMine ? "交回 Agent" : "接管";
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={36}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.swipeActions}>
          {primaryAction ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={primaryLabel}
              disabled={busy}
              onPress={primaryAction}
              style={({ pressed }) => [
                styles.swipeAction,
                styles.swipeActionPrimary,
                pressed && styles.swipeActionPressed,
                busy && styles.swipeActionBusy,
              ]}
            >
              <Text style={styles.swipeActionPrimaryText}>{primaryLabel}</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="隐藏"
            disabled={busy}
            onPress={onHide}
            style={({ pressed }) => [
              styles.swipeAction,
              styles.swipeActionMuted,
              pressed && styles.swipeActionPressed,
            ]}
          >
            <Text style={styles.swipeActionMutedText}>隐藏</Text>
          </Pressable>
        </View>
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.name}，${item.preview}`}
        onPress={onPress}
        style={({ pressed }) => [
          styles.row,
          !last && styles.rowDivider,
          pressed && styles.rowPressed,
        ]}
      >
        {tone === "orange" || tone === "blue" ? (
          <View
            style={[
              styles.toneBar,
              tone === "orange" ? styles.toneBarOrange : styles.toneBarBlue,
            ]}
          />
        ) : null}
        <View style={styles.avatarWrap}>
          {sessionToken ? (
            <UserAvatar
              contactId={item.contactId}
              fallbackName={item.name}
              sessionToken={sessionToken}
              size={40}
            />
          ) : (
            <View style={styles.avatarFallbackRow}>
              <Text style={styles.avatarFallbackRowText}>
                {item.name.slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          <View
            style={[
              styles.stateDot,
              item.state === "mine" && styles.stateDotMine,
              item.state === "agent" && styles.stateDotAgent,
              (item.state === "resolved" || item.state === "other") &&
                styles.stateDotNone,
            ]}
          />
        </View>
        <View style={styles.rowCopy}>
          <View style={styles.rowTopline}>
            <Text numberOfLines={1} style={styles.name}>
              {item.name}
            </Text>
            <Text style={styles.time}>{item.time}</Text>
          </View>
          <Text numberOfLines={1} style={styles.problem}>
            {item.preview || "打开会话查看"}
          </Text>
        </View>
        {item.state === "agent" && (item.unread ?? 0) > 0 ? (
          <View style={styles.unreadBadge}>
            <Text style={styles.unreadBadgeText}>
              {(item.unread ?? 0) > 99 ? "99+" : item.unread}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </ReanimatedSwipeable>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.canvas },
    header: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12 },
    headerTopline: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    headerTabs: { flexDirection: "row", alignItems: "center", gap: 18 },
    tabTitle: { color: colors.muted, fontSize: 17, fontWeight: "600" },
    tabTitleActive: { color: colors.ink, fontSize: 22, fontWeight: "800" },
    headerActions: { flexDirection: "row", alignItems: "center", gap: 10 },
    iconButton: {
      width: uiTokens.control.minTouch,
      height: uiTokens.control.minTouch,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarButton: { padding: 2 },
    avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.subtle },
    avatarFallback: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.ink,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarFallbackText: { color: colors.paper, fontSize: 14, fontWeight: "800" },
    searchBox: {
      minHeight: 46,
      borderRadius: 12,
      backgroundColor: colors.paper,
      borderWidth: 1,
      borderColor: colors.rule,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 13,
      gap: 9,
    },
    searchInput: { flex: 1, color: colors.ink, fontSize: 15, minHeight: 44 },
    refreshNotice: {
      marginHorizontal: 20,
      marginBottom: 4,
      minHeight: 36,
      borderRadius: 8,
      backgroundColor: colors.blueWash,
      alignItems: "center",
      justifyContent: "center",
    },
    refreshNoticeText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
    offlineBanner: {
      marginHorizontal: 20,
      marginBottom: 4,
      minHeight: 36,
      borderRadius: 8,
      backgroundColor: colors.orangeWash,
      alignItems: "center",
      justifyContent: "center",
    },
    offlineBannerText: { color: colors.orange, fontSize: 12, fontWeight: "700" },
    list: { paddingHorizontal: 20, paddingBottom: 36, flexGrow: 1 },
    // 折叠条：色点 + 计数 + 箭头（无文字）
    groupBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingTop: 12,
      paddingBottom: 6,
      paddingHorizontal: 2,
    },
    groupBarPressed: { opacity: 0.7 },
    groupDot: { width: 8, height: 8, borderRadius: 4 },
    groupDotOrange: { backgroundColor: colors.orange },
    groupDotBlue: { backgroundColor: colors.primary },
    groupDotGray: { backgroundColor: colors.muted },
    groupDotNone: { backgroundColor: colors.rule },
    groupTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
    groupCount: { color: colors.muted, fontSize: 11, fontWeight: "700" },
    row: {
      minHeight: 76,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingLeft: 18,
      position: "relative",
      backgroundColor: colors.canvas,
    },
    // 克制配色：短段色条（居中，不与相邻行连通）
    toneBar: {
      position: "absolute",
      left: 6,
      top: "50%",
      marginTop: -22,
      width: 3,
      height: 44,
      borderRadius: 1.5,
    },
    toneBarOrange: { backgroundColor: colors.orange },
    toneBarBlue: { backgroundColor: colors.primary },
    rowDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.rule,
    },
    rowPressed: { opacity: 0.8 },
    avatarWrap: { position: "relative" },
    avatarFallbackRow: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.subtle,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarFallbackRowText: { color: colors.ink, fontSize: 15, fontWeight: "600" },
    stateDot: {
      position: "absolute",
      right: -1,
      bottom: -1,
      width: 11,
      height: 11,
      borderRadius: 5.5,
      backgroundColor: colors.orange,
      borderWidth: 2,
      borderColor: colors.canvas,
    },
    stateDotMine: { backgroundColor: colors.primary },
    stateDotAgent: { backgroundColor: colors.muted },
    stateDotNone: { backgroundColor: colors.rule },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTopline: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    name: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: "700" },
    time: { color: colors.muted, fontSize: 11 },
    problem: { color: colors.muted, fontSize: 14, marginTop: 6 },
    unreadBadge: {
      minWidth: 18,
      height: 18,
      borderRadius: 8,
      backgroundColor: colors.red,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 5,
      alignSelf: "flex-start",
      marginTop: 8,
    },
    unreadBadgeText: { color: colors.paper, fontSize: 10, fontWeight: "800" },
    swipeActions: { flexDirection: "row" },
    swipeAction: { width: 88, alignItems: "center", justifyContent: "center" },
    swipeActionPrimary: { backgroundColor: colors.primary },
    swipeActionMuted: { backgroundColor: colors.subtle },
    swipeActionPressed: { opacity: 0.8 },
    swipeActionBusy: { opacity: 0.6 },
    swipeActionPrimaryText: { color: colors.onPrimary, fontSize: 13, fontWeight: "700" },
    swipeActionMutedText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
    contactRow: {
      minHeight: 64,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
    },
    contactCopy: { flex: 1, minWidth: 0 },
    contactName: { color: colors.ink, fontSize: 15, fontWeight: "700" },
    contactPreview: { color: colors.muted, fontSize: 13, marginTop: 4 },
    empty: { alignItems: "center", paddingTop: 90, paddingHorizontal: 24 },
    emptyTitle: { color: colors.muted, fontSize: 15, fontWeight: "600" },
    center: { alignItems: "center", paddingTop: 80 },
  });

/** 分组标题映射 */
function groupTitle(key: string): string {
  switch (key) {
    case "need":
      return "需要处理";
    case "mine":
      return "我处理中";
    case "agent":
      return "Agent 处理中";
    case "quiet":
      return "普通会话";
    default:
      return "搜索结果";
  }
}
