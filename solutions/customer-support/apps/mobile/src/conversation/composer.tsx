import { useEffect, useState } from "react";
import { ActivityIndicator, Animated, Keyboard, Pressable, Text, TextInput, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { X } from "phosphor-react-native/src/icons/X";
import { Plus } from "phosphor-react-native/src/icons/Plus";
import { PaperPlaneRight } from "phosphor-react-native/src/icons/PaperPlaneRight";
import { ArrowsLeftRight } from "phosphor-react-native/src/icons/ArrowsLeftRight";
import { Image as ImageIcon } from "phosphor-react-native/src/icons/Image";
import { File } from "phosphor-react-native/src/icons/File";
import { DotsThree } from "phosphor-react-native/src/icons/DotsThree";
import { useTheme, useThemedStyles } from "@/ui/theme-context";


import type { LocalDraft } from "@/conversations/draft-store-core";
import type { DisplayMessage, SendFailure } from "./types";
import { messageKind } from "@/conversations/message-presentation";


import { createStyles } from "./styles";

/** 当前 owner 的精简回复框：草稿、转交与联系人资料。 */
export function Composer({
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
  onPickAsset,
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
  onPickAsset?: () => void;
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
          <Pressable
            onPress={() => runTool(onPickAsset ?? (() => {}))}
            disabled={disabled}
            style={styles.moreActionButton}
          >
            <DotsThree size={20} color={colors.ink} />
            <Text style={styles.moreActionTitle}>素材空间</Text>
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
