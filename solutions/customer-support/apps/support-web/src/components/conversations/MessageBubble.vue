<script setup lang="ts">
/**
 * 单条消息气泡：微信客户端式渲染。
 * 覆盖 拍一拍/系统事件/文本/图片/文件/语音/表情包贴纸/引用回复/@提及/
 * 发送状态（failed/unknown）等形态。逻辑与旧版一致，只重写视觉。
 */
import { computed } from "vue";
import { useWeflowAuthStore } from "../../auth-store";
import MediaImage from "../MediaImage.vue";
import MediaFile from "../MediaFile.vue";
import VoiceMessage from "../VoiceMessage.vue";
import AvatarImage from "../AvatarImage.vue";
import StaffAvatar from "../StaffAvatar.vue";
import {
  actorLabel,
  bubbleText,
  isEmotionMessage,
  isEmotionSticker,
  isFileMessage,
  isImageMessage,
  isNonDefaultSendState,
  isPatMessage,
  isVoiceMsg,
  mentionSegments,
  messageTime,
  quotedSummary,
  sendStateLabel,
  type Message,
} from "./types";

const props = defineProps<{
  message: Message;
  /** 当前会话是否为群聊 */
  isGroup: boolean;
  /** 当前会话联系人（入站头像用） */
  contactId?: string | null;
  contactFallbackName?: string;
  /** 是否为定位目标（深链 messageId） */
  highlighted?: boolean;
  /** 完整消息列表（引用回复找原消息） */
  messages: Message[];
}>();

const emit = defineEmits<{
  contextmenu: [event: MouseEvent, message: Message];
  retry: [message: Message];
  "check-outcome": [message: Message];
}>();

const auth = useWeflowAuthStore();
const retryBusy = defineModel<boolean>("retryBusy", { default: false });
const outcomeBusy = defineModel<boolean>("outcomeBusy", { default: false });

const quoted = computed(() =>
  props.message.replyToChannelMessageId
    ? props.messages.find((m) => m.messageId === props.message.replyToChannelMessageId)
    : undefined,
);
const segments = computed(() => mentionSegments(bubbleText(props.message)));
const hasMention = computed(() => segments.value.some((s) => s.mention));
// 气泡 meta 降噪：客户只显示时间；Agent 显示身份；人工显示本人用户名
function bubbleMetaLabel(message: Message): string {
  if (message.actorType === "agent") return "Agent";
  if (message.direction === "inbound") return "";
  return message.actorId === auth.user?.userId
    ? (auth.user?.username ?? "我")
    : "其他客服";
}
</script>

<template>
  <div
    :id="`message-${message.messageId}`"
    class="flex flex-col"
    :class="[
      message.direction === 'outbound' ? 'items-end' : 'items-start',
      { 'scroll-mt-4': highlighted },
    ]"
    @contextmenu="emit('contextmenu', $event, message)"
  >
    <!-- 拍一拍：居中系统小字（同微信） -->
    <div v-if="isPatMessage(message)" class="my-1.5 self-center text-xs text-muted-foreground">
      {{ /拍了拍/.test(message.text || "") ? message.text : "对方拍了拍你" }}
    </div>

    <!-- 系统事件：居中灰字 -->
    <div v-else-if="message.actorType === 'system'" class="my-1.5 self-center text-center text-xs leading-relaxed text-muted-foreground">
      {{ message.text || "系统事件" }}
      <span class="ml-1 opacity-70">{{ messageTime(message.occurredAt) }}</span>
    </div>

    <template v-else>
      <div class="flex w-full items-start gap-1.5" :class="message.direction === 'outbound' ? 'flex-row-reverse' : ''">
        <!-- 入站：客户头像 -->
        <AvatarImage
          v-if="message.direction === 'inbound' && contactId"
          :contact-id="contactId"
          :fallback-text="message.senderName || contactFallbackName || ''"
          :size="28"
          class="mt-0.5 shrink-0"
        />
        <div class="flex min-w-0 max-w-[78%] flex-col gap-0.5" :class="message.direction === 'outbound' ? 'items-end' : 'items-start'">
          <!-- 群聊入站消息显示发送者昵称 -->
          <div
            v-if="isGroup && message.direction === 'inbound' && message.senderName"
            class="px-1 text-[11px] text-muted-foreground"
          >{{ message.senderName }}</div>

          <!-- 气泡主体：媒体/贴纸裸渲染；文本气泡按方向着色
               （我方人工=primary 实底反白；Agent=secondary 浅底；客户=muted 灰底） -->
          <div
            class="min-w-0 max-w-full"
            :class="
              (isImageMessage(message) && message.mediaId) ||
              (isFileMessage(message) && message.mediaId) ||
              (isVoiceMsg(message) && message.mediaId) ||
              isEmotionSticker(message)
                ? ''
                : message.direction === 'outbound'
                  ? message.actorType === 'agent'
                    ? 'rounded-lg bg-secondary px-3 py-2 text-sm leading-relaxed text-secondary-foreground'
                    : 'rounded-lg bg-primary px-3 py-2 text-sm leading-relaxed text-primary-foreground'
                  : 'rounded-lg border border-border bg-muted px-3 py-2 text-sm leading-relaxed'
            "
            :style="{
              ...(isImageMessage(message) && message.mediaId
                ? { maxWidth: '300px' }
                : {}),
              ...(isEmotionSticker(message) ? { maxWidth: '160px' } : {}),
              ...(isFileMessage(message) && message.mediaId ? { maxWidth: '260px' } : {}),
            }"
          >
            <MediaImage
              v-if="isImageMessage(message) && message.mediaId"
              :media-id="message.mediaId"
              :alt="`${actorLabel(message)} 发送的图片`"
              class="max-h-[300px] max-w-[300px] rounded-lg object-cover"
            />
            <MediaImage
              v-else-if="isEmotionSticker(message)"
              :media-id="message.mediaId!"
              :alt="`${actorLabel(message)} 发送的表情包`"
              class="max-h-[160px] max-w-[160px] object-contain"
            />
            <MediaFile
              v-else-if="isFileMessage(message) && message.mediaId"
              :media-id="message.mediaId"
              :file-name="message.mediaFileName ?? undefined"
              :alt="`${actorLabel(message)} 发送的文件`"
            />
            <VoiceMessage
              v-else-if="isVoiceMsg(message) && message.mediaId"
              :media-id="message.mediaId"
              :alt="`${actorLabel(message)} 发送的语音`"
            />
            <template v-else>
              <!-- 引用回复卡片 -->
              <div
                v-if="quoted"
                class="mb-1 rounded-sm border-l-2 border-muted-foreground/40 bg-muted/60 px-2 py-1 text-xs opacity-85"
              >
                <span class="block font-medium text-muted-foreground">{{ actorLabel(quoted) }}</span>
                <span class="block truncate text-muted-foreground">{{ quotedSummary(quoted) }}</span>
              </div>
              <!-- @提及高亮 -->
              <span
                v-if="!isEmotionMessage(message) && hasMention"
                class="whitespace-pre-wrap break-words"
              ><template
                  v-for="(seg, si) in segments"
                  :key="si"
                ><span
                    v-if="seg.mention"
                    class="font-semibold text-primary"
                >{{ seg.text }}</span><template v-else>{{ seg.text }}</template></template></span>
              <!-- 普通文本 -->
              <span v-else class="whitespace-pre-wrap break-words">{{ bubbleText(message) }}</span>
            </template>
          </div>

          <!-- meta 行：身份/时间/状态/操作（降噪，正常态消失） -->
          <div class="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground" :class="message.direction === 'outbound' ? 'flex-row-reverse' : ''">
            <span v-if="bubbleMetaLabel(message)">{{ bubbleMetaLabel(message) }}</span>
            <span class="tabular-nums">{{ messageTime(message.occurredAt) }}</span>
            <span
              v-if="isNonDefaultSendState(message)"
              :class="{ 'font-semibold text-destructive': message.sendState === 'failed' || message.sendState === 'unknown' }"
            >{{ sendStateLabel(message.sendState) }}</span>
            <button
              v-if="message.actorType !== 'agent' && message.direction === 'outbound' && message.sendState === 'failed'"
              class="text-primary hover:underline"
              :disabled="retryBusy"
              @click="emit('retry', message)"
            >
              重试
            </button>
            <button
              v-else-if="message.actorType !== 'agent' && message.direction === 'outbound' && message.sendState === 'unknown'"
              class="text-primary hover:underline"
              :disabled="outcomeBusy"
              @click="emit('check-outcome', message)"
            >
              查询结果
            </button>
          </div>
        </div>

        <!-- 出站：AI 员工头像 / 人工客服头像 -->
        <img
          v-if="message.actorType === 'agent' && message.actorAvatarUrl"
          :src="message.actorAvatarUrl"
          alt="AI 员工头像"
          class="mt-0.5 size-7 shrink-0 rounded-full object-cover"
          @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
        />
        <span
          v-else-if="message.actorType === 'agent'"
          class="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-xs font-bold text-secondary-foreground"
        >A</span>
        <StaffAvatar
          v-else-if="message.direction === 'outbound' && message.actorType !== 'agent'"
          :user-id="message.actorId || auth.user?.userId"
          :avatar-url="auth.user?.avatarUrl"
          :fallback-text="auth.user?.displayName || auth.user?.username || '我'"
          :size="28"
          class="mt-0.5 shrink-0"
        />
      </div>
    </template>
  </div>
</template>
