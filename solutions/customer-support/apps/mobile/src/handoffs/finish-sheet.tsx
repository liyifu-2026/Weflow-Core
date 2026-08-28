import * as Crypto from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/api/client";
import type { MobileCapabilities } from "@/api/capabilities";
import type { MobileSession } from "@/auth/session";
import {
  finishHandoff,
  getFinishContext,
  getHandoffOperationOutcome,
} from "@/conversations/api";
import type { FinishContext, HandoffState, HumanResult } from "./model";
import { useTheme, useThemedStyles } from "@/ui/theme-context";
import { useReducedMotion } from "@/ui/use-reduced-motion";

const resultOptions: { value: HumanResult; label: string }[] = [
  { value: "resolved_by_human", label: "已解决" },
  { value: "answered_question", label: "已提供处理方案" },
  { value: "information_collected", label: "已收集所需信息" },
  { value: "customer_no_response", label: "等待客户后续" },
  { value: "other", label: "其他" },
];

export function FinishHandoffSheet({
  visible,
  session,
  conversationId,
  handoffRevision,
  hasDraft,
  capabilities,
  onFinished,
  onClose,
}: {
  visible: boolean;
  session?: MobileSession;
  conversationId: string;
  handoffRevision?: number;
  hasDraft: boolean;
  capabilities: MobileCapabilities;
  onFinished: (state: HandoffState) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const [context, setContext] = useState<FinishContext>();
  const [result, setResult] = useState<HumanResult>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [requestStarted, setRequestStarted] = useState(false);
  const [outcomeUnresolved, setOutcomeUnresolved] = useState(false);
  const [error, setError] = useState<string>();
  const requestId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!visible || !session) return;
    let disposed = false;
    void Promise.resolve()
      .then(() => {
        if (disposed) return undefined;
        setLoading(true);
        setError(undefined);
        return getFinishContext(session, conversationId);
      })
      .then((next) => {
        if (!next || disposed) return;
        setContext(next);
        if (!next.requiresConfirmation && next.inferredResult) {
          setResult(next.inferredResult);
        }
      })
      .catch(() => {
        if (!disposed) setError("暂时无法确认本次处理结果，请稍后重试。");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [conversationId, session, visible]);

  function reset() {
    setContext(undefined);
    setResult(undefined);
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

  async function finish() {
    if (!session || handoffRevision === undefined || !context || submitting) return;
    if (context.requiresConfirmation && !result) return;
    const clientRequestId = requestId.current ?? Crypto.randomUUID();
    requestId.current = clientRequestId;
    setRequestStarted(true);
    setSubmitting(true);
    setError(undefined);
    try {
      const state = await finishHandoff(session, conversationId, {
          expectedHandoffRevision: handoffRevision,
          clientRequestId,
          result,
        });
      reset();
      onFinished(state);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status < 500) {
        requestId.current = undefined;
        setRequestStarted(false);
        setError("当前处理状态已经变化，请刷新后再确认。");
      } else if (capabilities.requestOutcome || capabilities.handoffOutcomeQuery) {
        setError("正在确认结束结果，请不要重复提交。");
        try {
          const outcome = await getHandoffOperationOutcome(
            session,
            "finish_handoff",
            clientRequestId,
          );
          if (outcome.status === "succeeded" && outcome.result) {
            reset();
            onFinished(outcome.result);
          } else if (outcome.status === "not_found" || outcome.status === "failed") {
            requestId.current = undefined;
            setRequestStarted(false);
            setError("已确认操作未完成，可以重新提交。");
          } else {
            setOutcomeUnresolved(true);
            setError("结束操作仍在处理中，请稍后再次确认。");
          }
        } catch {
          setOutcomeUnresolved(true);
          setError("暂时无法确认结束结果，请保持页面不变后重试。");
        }
      } else {
        setOutcomeUnresolved(true);
        setError("结束结果暂时无法确认，请不要重复提交。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? "none" : "slide"}
      onRequestClose={close}
    >
      <View style={styles.backdrop}>
        <Pressable disabled={submitting || outcomeUnresolved} onPress={close} style={styles.dismiss} accessibilityLabel="取消结束人工处理" />
        <SafeAreaView edges={["bottom"]} style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.title}>结束人工处理？</Text>
          <Text style={styles.body}>
            后续客户再次发来消息时，Agent 将重新负责处理。如果 Agent 再次无法可靠处理，会重新发起人工接管。
          </Text>
          {hasDraft ? (
            <View style={styles.warning}>
              <Text style={styles.warningTitle}>还有未发送的草稿</Text>
              <Text style={styles.warningText}>结束人工处理后，草稿将被删除。</Text>
            </View>
          ) : null}
          {loading ? <ActivityIndicator style={styles.loader} /> : null}
          {context?.requiresConfirmation ? (
            <View style={styles.results}>
              <Text style={styles.resultLabel}>这次人工处理结果</Text>
              {resultOptions.map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: result === option.value }}
                  disabled={requestStarted}
                  onPress={() => setResult(option.value)}
                  style={styles.resultRow}
                >
                  <View style={[styles.radio, result === option.value && styles.radioSelected]}>
                    {result === option.value ? <View style={styles.radioCore} /> : null}
                  </View>
                  <Text style={styles.resultText}>{option.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable disabled={submitting || outcomeUnresolved} onPress={close} style={[styles.cancel, (submitting || outcomeUnresolved) && styles.disabled]}>
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
            <Pressable
              disabled={loading || !context || (context.requiresConfirmation && !result) || submitting}
              onPress={() => void finish()}
              style={[styles.finish, (loading || !context || (context.requiresConfirmation && !result) || submitting) && styles.disabled]}
            >
              {submitting ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={styles.finishText}>结束</Text>}
            </Pressable>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "flex-end" },
  dismiss: { flex: 1 },
  sheet: { backgroundColor: colors.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18 },
  grabber: { width: 34, height: 4, borderRadius: 2, backgroundColor: colors.rule, alignSelf: "center", marginBottom: 18 },
  title: { color: colors.ink, fontSize: 20, fontWeight: "800" },
  body: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 10 },
  warning: { marginTop: 16, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.rule },
  warningTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" }, warningText: { color: colors.muted, fontSize: 12, marginTop: 4 },
  loader: { marginVertical: 22 }, results: { marginTop: 18 }, resultLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", marginBottom: 5 },
  resultRow: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 10 }, radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.5, borderColor: colors.rule, alignItems: "center", justifyContent: "center" },
  radioSelected: { borderColor: colors.blue }, radioCore: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.blue }, resultText: { color: colors.ink, fontSize: 14 },
  error: { color: colors.red, fontSize: 12, lineHeight: 17, marginTop: 12 }, actions: { flexDirection: "row", gap: 10, marginTop: 18 },
  cancel: { flex: 1, minHeight: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.rule, borderRadius: 12 },
  cancelText: { color: colors.ink, fontSize: 14, fontWeight: "700" }, finish: { flex: 1, minHeight: 46, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary, borderRadius: 12 },
  finishText: { color: colors.onPrimary, fontSize: 14, fontWeight: "800" }, disabled: { opacity: 0.42 },
});
