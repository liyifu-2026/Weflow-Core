import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { contactTagsInput, normalizeContactTags } from "@/conversations/contact-profile";
import { getContactProfile, updateContactProfile } from "@/conversations/api";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

import type { CollaborationRequest } from "@/collaboration/api";
import type { HandoffDetail } from "@/handoffs/model";
import { useReducedMotion } from "react-native-reanimated";
import { CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import type { MobileSession } from "@/auth/session";
import type { ContactProfile } from "@/conversations/api";
import type { ConversationPreview } from "@/conversations/model";


import { createStyles } from "./styles";

/**
 * 会话详情页弹层：归档草稿面板、会话菜单、联系人资料编辑。
 */

export function ArchivedDraftPanel({
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

export function ConversationMenuModal({
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
export function ContactProfileModal({
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
