/**
 * 协作请求 UI：发起摘要条与应答弹窗。
 */
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

import type { CollaborationRequest } from "@/collaboration/api";
import { createStyles } from "./styles";

export function CollaborationSummary({
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
export function CollaborationResponseModal({
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
