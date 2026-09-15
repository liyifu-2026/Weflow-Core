/**
 * 消息气泡：时间线单条消息渲染（文本/图片/文件/语音/拍一拍等）与消息头像。
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { apiBaseUrl } from "@/api/config";
import { formatTime } from "@/ui/format";
import { UserAvatar } from "@/ui/user-avatar";
import { UserCircle } from "phosphor-react-native/src/icons/UserCircle";
import { useTheme, useThemedStyles } from "@/ui/theme-context";

import { emotionDisplayText, mentionSegments, messageKind, patNoticeText } from "@/conversations/message-presentation";
import { createStyles } from "./styles";
import { failureCopy, sendStateCopy } from "./screen-helpers";
import type { MobileSession } from "@/auth/session";
import { MediaFileBubble } from "@/media/media-file-bubble";
import { MediaImage } from "@/media/media-image";
import { VoiceBubble } from "@/media/voice-bubble";
import { MediaViewerModal } from "@/media/media-viewer";
import type { DisplayMessage } from "./types";

export function TranscriptMessage({
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
  // 文件消息：contentType=file（回声行）或 mediaKind=file（融合后的 manual 行）
  const isFileMessage =
    message.contentType === "file" || message.mediaKind === "file";
  // 视频消息：contentType=video（回声行）或 mediaKind=video（融合后的行）；
  // 走文件卡片 + expo-video 预览（与 mp4/mov 附件同一实现）
  const isVideoMessage =
    message.contentType === "video" || message.mediaKind === "video";
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
  const displayText =
    stickerText ??
    (isImageMessage
      ? "图片需联网查看"
      : isVideoMessage
        ? message.mediaFileName || "视频"
        : isFileMessage
          ? message.mediaFileName || "文件"
          : message.text || "[非文本消息]");
  const segments =
    stickerText === null && !isImageMessage && !isFileMessage && !isVideoMessage
      ? mentionSegments(displayText)
      : [];
  const hasMentions = segments.some((s) => s.mention);
  // 人工消息头像按发送者绑定：本人消息用 auth me 缓存的 avatarUrl；他人
  // 消息走 GET /users/:id/avatar（登录即可读，Core 回落到该客服的预设头像），
  // 保证不同客服的气泡头像互不相同。
  const isOwnManual =
    !message.actorId || message.actorId === session?.user.userId;
  const manualAvatarUrl = isOwnManual
    ? session?.user.avatarUrl ?? null
    : `/api/v1/users/${encodeURIComponent(message.actorId!)}/avatar`;
  return (
    <>
      <View
        accessible={!isImageMessage && !isFileMessage && !isVideoMessage}
        accessibilityLabel={`${label}，${isImageMessage ? "图片消息" : isVideoMessage ? "视频消息" : isFileMessage ? `文件消息 ${message.mediaFileName ?? ""}` : message.text || "非文本消息"}${showTime ? `，${formatTime(message.occurredAt)}` : ""}`}
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
            // 图片/文件/视频/表情裸渲染：去掉聊天气泡底（微信式）
            ((isImageMessage && message.mediaId && session) ||
              (isFileMessage && message.mediaId && session) ||
              (isVideoMessage && message.mediaId && session) ||
              (stickerText !== null && Boolean(message.mediaId))
              ? styles.bubbleBare
              : null),
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
          ) : isFileMessage && message.mediaId && session ? (
            <MediaFileBubble
              session={session}
              mediaId={message.mediaId}
              fileName={message.mediaFileName}
              align={right ? "right" : "left"}
            />
          ) : isVideoMessage && message.mediaId && session ? (
            <MediaFileBubble
              session={session}
              mediaId={message.mediaId}
              // 入站视频可能没有原始文件名：给 .mp4 兜底，保证走视频预览而非分享面板
              fileName={message.mediaFileName ?? "video.mp4"}
              align={right ? "right" : "left"}
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
                : isVideoMessage
                  ? message.mediaFileName || "视频"
                  : isFileMessage
                    ? message.mediaFileName || "文件"
                    : message.text || "[非文本消息]"}
            </Text>
          )}
          {kind === "manual" && message.sendState && (
            <Pressable onPress={onRetry} disabled={!onRetry}>
              <Text
                style={[
                  styles.pending,
                  // 媒体裸渲染后无深色底：状态文字改用可读的次级色
                  (isImageMessage || isFileMessage || isVideoMessage) && styles.pendingOnBare,
                ]}
              >
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
            avatarUrl={manualAvatarUrl}
            sessionToken={session?.sessionToken}
            initial={isOwnManual
              ? (
                session?.user.displayName ||
                session?.user.username ||
                "客"
              ).slice(0, 1)
              : "客"}
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
 * - 人工客服：优先 avatarUrl（本人=auth me 的 avatarUrl；其他客服=/users/:id/avatar），
 *   加载失败回退首字母；
 * - AI 员工：平台 DiceBear 代理按员工标识确定性出图（voxel-bot），加载失败
 *   回退固定标识；不同员工头像不同，可区分是哪个 AI 发的消息。
 */
export function MessageAvatar({
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
  const [avatarFailed, setAvatarFailed] = useState(false);
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
    (kind === "agent" || kind === "manual") &&
    avatarUrl &&
    sessionToken &&
    !avatarFailed
  ) {
    return (
      <Image
        cachePolicy="memory"
        source={{
          uri: `${apiBaseUrl}${avatarUrl}`,
          headers: { authorization: `Bearer ${sessionToken}` },
        }}
        style={styles.messageAvatarImage}
        onError={() => setAvatarFailed(true)}
        accessibilityLabel={kind === "agent" ? "AI 员工头像" : "客服头像"}
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
      ) : kind === "customer" ? (
        <UserCircle size={14} color={colors.muted} weight="fill" />
      ) : (
        <Text style={styles.messageAvatarText}>{initial}</Text>
      )}
    </View>
  );
}

