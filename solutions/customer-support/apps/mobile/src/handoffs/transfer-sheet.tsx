import * as Crypto from "expo-crypto";
import { Image } from "expo-image";
import { MagnifyingGlass } from "phosphor-react-native/src/icons/MagnifyingGlass";
import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiBaseUrl } from "@/api/config";
import { ApiError } from "@/api/client";
import type { MobileCapabilities } from "@/api/capabilities";
import type { MobileSession } from "@/auth/session";
import {
  getHandoffOperationOutcome,
  getTransferPreview,
  listHandoffAssignees,
  listSpecialistQueueTargets,
  transferHandoffV2,
} from "@/conversations/api";
import type {
  HandoffAssignee,
  HandoffState,
  SpecialistQueueTarget,
  TransferPreview,
} from "./model";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { useReducedMotion } from "@/ui/use-reduced-motion";

type Target =
  | {
      type: "user";
      id: string;
      displayName: string;
      detail?: string | null;
      avatarUrl?: string | null;
    }
  | { type: "queue"; id: string; displayName: string; detail?: string | null };

export function TransferSheet({
  visible,
  session,
  conversationId,
  handoffRevision,
  capabilities,
  onTransferred,
  onClose,
}: {
  visible: boolean;
  session?: MobileSession;
  conversationId: string;
  handoffRevision?: number;
  capabilities: MobileCapabilities;
  onTransferred: (state: HandoffState, target: Target) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState<"type" | "target" | "confirm">("type");
  const [targetType, setTargetType] = useState<Target["type"]>();
  const [target, setTarget] = useState<Target>();
  const [users, setUsers] = useState<HandoffAssignee[]>([]);
  const [queues, setQueues] = useState<SpecialistQueueTarget[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<TransferPreview>();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [requestStarted, setRequestStarted] = useState(false);
  const [outcomeUnresolved, setOutcomeUnresolved] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef<string | undefined>(undefined);

  function reset() {
    setStep("type");
    setTargetType(undefined);
    setTarget(undefined);
    setQuery("");
    setPreview(undefined);
    setReason("");
    setError(undefined);
    setRequestStarted(false);
    setOutcomeUnresolved(false);
    requestId.current = undefined;
  }

  function close() {
    if (submitting || outcomeUnresolved) return;
    reset();
    onClose();
  }

  const targets = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const source: Target[] =
      targetType === "user"
        ? users.map((user) => ({
            type: "user" as const,
            id: user.userId,
            displayName: user.displayName,
            detail: user.specialtyLabel,
            avatarUrl: user.avatarUrl ?? null,
          }))
        : queues.map((queue) => ({
            type: "queue" as const,
            id: queue.queueId,
            displayName: queue.displayName,
            detail: queue.shortDescription,
            avatarUrl: null,
          }));
    return needle
      ? source.filter((item) =>
          `${item.displayName} ${item.detail ?? ""}`
            .toLocaleLowerCase("zh-CN")
            .includes(needle),
        )
      : source;
  }, [query, queues, targetType, users]);

  async function chooseType(type: Target["type"]) {
    if (!session) return;
    setTargetType(type);
    setStep("target");
    setLoading(true);
    setError(undefined);
    try {
      if (type === "user") setUsers(await listHandoffAssignees(session));
      else setQueues(await listSpecialistQueueTargets(session));
    } catch {
      setError("暂时无法读取可转交对象，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function chooseTarget(next: Target) {
    if (!session) return;
    setTarget(next);
    setStep("confirm");
    setLoading(true);
    setError(undefined);
    try {
      setPreview(
        await getTransferPreview(session, conversationId, {
          targetType: next.type,
          targetId: next.id,
        }),
      );
    } catch {
      setError("结构化交接暂时无法准备，请返回后重试。");
    } finally {
      setLoading(false);
    }
  }

  async function confirmTransfer() {
    if (
      !session ||
      !target ||
      !preview ||
      handoffRevision === undefined ||
      submitting
    ) return;
    const clientRequestId = requestId.current ?? Crypto.randomUUID();
    requestId.current = clientRequestId;
    setRequestStarted(true);
    setSubmitting(true);
    setError(undefined);
    try {
      const state = await transferHandoffV2(session, conversationId, {
        targetType: target.type,
        targetId: target.id,
        transferReason: reason.trim() || undefined,
        sourceConversationRevision: preview.context.sourceConversationRevision,
        expectedHandoffRevision: handoffRevision,
        clientRequestId,
      });
      reset();
      onTransferred(state, target);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) {
        requestId.current = undefined;
        setRequestStarted(false);
        setError(
          failure.code === "stale_handoff_context"
            ? "会话已有新内容，请返回刷新后重新确认转交。"
            : "当前状态已变化，转交没有完成。",
        );
      } else if (capabilities.requestOutcome || capabilities.handoffOutcomeQuery) {
        setError("正在确认转交结果，请不要重复提交。");
        try {
          const outcome = await getHandoffOperationOutcome(
            session,
            "transfer_handoff",
            clientRequestId,
          );
          if (outcome.status === "succeeded" && outcome.result) {
            reset();
            onTransferred(outcome.result, target);
          } else if (outcome.status === "not_found" || outcome.status === "failed") {
            requestId.current = undefined;
            setRequestStarted(false);
            setError("已确认转交未完成，可以重新提交。");
          } else {
            setOutcomeUnresolved(true);
            setError("转交仍在处理中，请稍后再次确认。");
          }
        } catch {
          setOutcomeUnresolved(true);
          setError("暂时无法确认转交结果，请保持页面不变后重试。");
        }
      } else {
        setOutcomeUnresolved(true);
        setError("转交结果暂时无法确认，请不要重复提交。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!visible) return null;
  return (
    <Modal
      visible
      transparent
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={close}
    >
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="关闭转交处理" disabled={submitting || outcomeUnresolved} onPress={close} style={styles.dismiss} />
        <SafeAreaView edges={["bottom"]} style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>转交处理</Text>
              <Text style={styles.subtitle}>
                {step === "type"
                  ? "选择交给谁继续处理"
                  : step === "target"
                    ? targetType === "user" ? "选择客服" : "选择专业队列"
                    : `转给 ${target?.displayName ?? ""}`}
              </Text>
            </View>
            <Pressable disabled={submitting || outcomeUnresolved} onPress={close} hitSlop={10}>
              <Text style={[styles.close, (submitting || outcomeUnresolved) && styles.closeDisabled]}>关闭</Text>
            </Pressable>
          </View>

          {step === "type" ? (
            <View style={styles.typeList}>
              {capabilities.transferCycle &&
              capabilities.transferToUser &&
              capabilities.transferFallback ? (
                <TargetTypeRow
                  title="转给客服"
                  detail="我知道由谁继续处理"
                  onPress={() => void chooseType("user")}
                />
              ) : null}
              {capabilities.transferCycle && capabilities.transferToQueue ? (
                <TargetTypeRow
                  title="转给专业队列"
                  detail="由对应团队安排合适的人"
                  onPress={() => void chooseType("queue")}
                />
              ) : null}
            </View>
          ) : step === "target" ? (
            <View style={styles.targetArea}>
              {targetType === "user" ? (
                <View style={styles.search}>
                  <MagnifyingGlass size={17} color={colors.muted} />
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder="搜索客服"
                    style={styles.searchInput}
                  />
                </View>
              ) : null}
              {loading ? (
                <ActivityIndicator style={styles.loader} />
              ) : (
                <ScrollView style={styles.targetList} showsVerticalScrollIndicator={false}>
                  {targets.map((item) => (
                    <Pressable
                      key={`${item.type}:${item.id}`}
                      onPress={() => void chooseTarget(item)}
                      style={({ pressed }) => [styles.targetRow, pressed && styles.pressed]}
                    >
                      {item.type === "user" && item.avatarUrl && session ? (
                        <Image
                          source={{
                            uri: `${apiBaseUrl}${item.avatarUrl}`,
                            headers: { authorization: `Bearer ${session.sessionToken}` },
                          }}
                          style={styles.targetAvatar}
                          contentFit="cover"
                          accessibilityLabel={item.displayName}
                        />
                      ) : (
                        <View style={styles.targetMark} />
                      )}
                      <View style={styles.targetCopy}>
                        <Text style={styles.targetName}>{item.displayName}</Text>
                        {item.detail ? <Text style={styles.targetDetail}>{item.detail}</Text> : null}
                      </View>
                    </Pressable>
                  ))}
                  {!targets.length && !error ? (
                    <Text style={styles.empty}>当前没有可接收的对象</Text>
                  ) : null}
                </ScrollView>
              )}
              <Pressable onPress={() => setStep("type")} style={styles.back}>
                <Text style={styles.backText}>返回选择类型</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.confirm} keyboardShouldPersistTaps="handled">
              {loading ? <ActivityIndicator style={styles.loader} /> : preview ? (
                <>
                  <BriefBlock label="当前问题" items={[preview.context.problemSummary]} />
                  <BriefBlock
                    label="已确认"
                    items={preview.context.confirmedFacts.map((fact) => `${fact.label} · ${fact.value}`)}
                  />
                  <BriefBlock label="已经尝试" items={preview.context.triedSteps} />
                  <BriefBlock
                    label="仍需确认"
                    items={preview.context.missingInformation.map((item) => item.label)}
                  />
                  <BriefBlock label="仍未解决" items={preview.context.unresolvedItems} />
                  <BriefBlock
                    label="建议下一步"
                    items={preview.context.suggestedNextStep ? [preview.context.suggestedNextStep] : []}
                  />
                  <Text style={styles.reasonLabel}>转交说明（可选）</Text>
                  <TextInput
                    value={reason}
                    onChangeText={setReason}
                    autoFocus={!requestStarted}
                    editable={!requestStarted}
                    maxLength={240}
                    multiline
                    placeholder="给下一位客服补充一句话…"
                    style={styles.reasonInput}
                  />
                  <Text style={styles.ownershipCopy}>
                    确认后你将立即失去本会话的回复权限，聊天记录和处理上下文会一起交接。
                  </Text>
                </>
              ) : null}
              {!requestStarted ? (
                <Pressable onPress={() => setStep("target")} style={styles.back}>
                  <Text style={styles.backText}>重新选择</Text>
                </Pressable>
              ) : null}
            </ScrollView>
          )}

          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          {step === "confirm" ? (
            <Pressable
              disabled={!preview || submitting}
              onPress={() => void confirmTransfer()}
              style={[styles.primary, (!preview || submitting) && styles.disabled]}
            >
              {submitting ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.primaryText}>确认转交</Text>}
            </Pressable>
          ) : null}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function TargetTypeRow({ title, detail, onPress }: { title: string; detail: string; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.typeRow, pressed && styles.pressed]}>
      <View style={styles.typeCopy}>
        <Text style={styles.typeTitle}>{title}</Text>
        <Text style={styles.typeDetail}>{detail}</Text>
      </View>
      <Text style={styles.caret}>›</Text>
    </Pressable>
  );
}

function BriefBlock({ label, items }: { label: string; items: string[] }) {
  const styles = useThemedStyles(createStyles);
  if (!items.length) return null;
  return (
    <View style={styles.briefBlock}>
      <Text style={styles.briefLabel}>{label}</Text>
      {items.map((item, index) => <Text key={`${label}-${index}`} style={styles.briefText}>• {item}</Text>)}
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "flex-end" },
  dismiss: { flex: 1 },
  sheet: { maxHeight: "88%", minHeight: 360, backgroundColor: colors.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18 },
  grabber: { width: 34, height: 4, borderRadius: 2, backgroundColor: colors.rule, alignSelf: "center", marginBottom: 14 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  title: { color: colors.ink, fontSize: 20, fontWeight: "800" },
  subtitle: { color: colors.muted, fontSize: 12, marginTop: 4 },
  close: { color: colors.blue, fontSize: 13, fontWeight: "700" },
  closeDisabled: { color: colors.muted },
  typeList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.rule },
  typeRow: { minHeight: 70, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule },
  typeCopy: { flex: 1 }, typeTitle: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  typeDetail: { color: colors.muted, fontSize: 12, marginTop: 5 }, caret: { color: colors.muted, fontSize: 24 },
  targetArea: { minHeight: 300 }, search: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: colors.rule, borderRadius: 12, paddingHorizontal: 12 },
  searchInput: { flex: 1, minHeight: 42, color: colors.ink }, targetList: { maxHeight: 360, marginTop: 10 },
  targetRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule },
  targetMark: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue }, targetCopy: { flex: 1 },
  targetAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.subtle },
  targetName: { color: colors.ink, fontSize: 14, fontWeight: "700" }, targetDetail: { color: colors.muted, fontSize: 11, marginTop: 4 },
  targetListSpacer: { height: 8 }, loader: { paddingVertical: 32 }, empty: { color: colors.muted, textAlign: "center", paddingVertical: 30 },
  confirm: { paddingBottom: 8 }, briefBlock: { marginBottom: 14 }, briefLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", marginBottom: 6 },
  briefText: { color: colors.ink, fontSize: 13, lineHeight: 20, marginBottom: 2 }, reasonLabel: { color: colors.ink, fontSize: 13, fontWeight: "700", marginTop: 4, marginBottom: 8 },
  reasonInput: { minHeight: 88, borderWidth: 1, borderColor: colors.rule, borderRadius: 12, padding: 12, color: colors.ink, textAlignVertical: "top" },
  ownershipCopy: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 10 }, back: { minHeight: 42, justifyContent: "center", alignSelf: "flex-start" }, backText: { color: colors.blue, fontSize: 12, fontWeight: "700" },
  error: { color: colors.red, fontSize: 12, lineHeight: 17, marginVertical: 8 }, primary: { minHeight: 48, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", marginTop: 8 },
  primaryText: { color: colors.onPrimary, fontSize: 14, fontWeight: "800" }, disabled: { opacity: 0.42 }, pressed: { opacity: 0.62 },
});
