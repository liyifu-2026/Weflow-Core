<script setup lang="ts">
/**
 * 输入区（Composer）：表情 / 图片 / 文件 / 素材空间 工具行 + 文本域 + 发送。
 * 含 @提及浮层与引用回复预览。发送与上传逻辑由父级注入。
 */
import { ref } from "vue";
import { Image, Library, Paperclip, Smile, X } from "lucide-vue-next";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { Message } from "./types";

const props = defineProps<{
  /** 父级注入的联系人/客服候选（@提及） */
  mentionContacts: Array<{ id: string; name: string }>;
  /** pending：先领取会话；他人 in_progress：只读 */
  placeholder: string;
  disabled: boolean;
  sending: boolean;
  canReply: boolean;
  isMine: boolean;
  mediaUploading: boolean;
  replyTarget: Message | null;
}>();

const emit = defineEmits<{
  "update:text": [value: string];
  send: [];
  "pick-image": [event: Event];
  "pick-file": [event: Event];
  "open-assets": [];
  "clear-reply": [];
  "focus-input": [];
}>();

const text = defineModel<string>("text", { default: "" });
const toolHint = defineModel<string>("toolHint", { default: "" });

const emojiPickerOpen = ref(false);
const mentionOpen = ref(false);
const mentionFilter = ref("");
const imageInputRef = ref<HTMLInputElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const EMOJI_CHOICES = [
  "😀","😁","😂","🤣","😅","😊","😍","😘",
  "😜","🤗","🤔","😴","😭","😤","😡","🥺",
  "👍","👏","🙏","💪","🤝","👌","✌️","👋",
  "❤️","💔","🎉","🎂","🌹","⚡","☀️","🌙",
];

const filteredMentionContacts = ref<Array<{ id: string; name: string }>>([]);
function onReplyInput(event: Event) {
  const textarea = event.target as HTMLTextAreaElement;
  const val = textarea.value;
  const cursorPos = textarea.selectionStart ?? 0;
  const before = val.slice(0, cursorPos);
  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1 || (atIdx > 0 && before[atIdx - 1] !== " " && before[atIdx - 1] !== "\n")) {
    mentionOpen.value = false;
    emit("update:text", val);
    return;
  }
  const query = before.slice(atIdx + 1);
  if (/\s/.test(query)) {
    mentionOpen.value = false;
    emit("update:text", val);
    return;
  }
  mentionFilter.value = query;
  const q = query.toLowerCase();
  filteredMentionContacts.value = q
    ? props.mentionContacts.filter((c) => c.name.toLowerCase().includes(q))
    : props.mentionContacts;
  mentionOpen.value = true;
  emit("update:text", val);
}
function selectMentionContact(contact: { id: string; name: string }) {
  const textarea = textareaRef.value;
  if (!textarea) return;
  const val = textarea.value;
  const cursorPos = textarea.selectionStart ?? val.length;
  const before = val.slice(0, cursorPos);
  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1) return;
  const after = val.slice(cursorPos);
  text.value = `${val.slice(0, atIdx)}@${contact.name} ${after}`;
  mentionOpen.value = false;
  requestAnimationFrame(() => {
    const newPos = atIdx + contact.name.length + 2;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
  });
}
function insertEmoji(emoji: string) {
  text.value = `${text.value}${emoji}`;
  emit("update:text", text.value);
}
/** 供父级读取 textarea（mention 光标恢复等） */
defineExpose({ textareaRef, imageInputRef, fileInputRef });
</script>

<template>
  <div class="relative border-t border-border bg-background px-3 pb-2 pt-1.5">
    <!-- 工具提示（上传失败等） -->
    <div
      v-if="toolHint"
      class="absolute -top-9 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-3 py-1.5 text-xs text-background"
    >
      {{ toolHint }}
    </div>

    <!-- 表情选择浮层 -->
    <div
      v-if="emojiPickerOpen"
      class="absolute bottom-full left-2 z-20 mb-1.5 grid w-fit grid-cols-8 gap-0.5 rounded-lg border border-border bg-popover p-2 shadow-md"
    >
      <button
        v-for="emoji in EMOJI_CHOICES"
        :key="emoji"
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-muted"
        @click="insertEmoji(emoji)"
      >
        {{ emoji }}
      </button>
    </div>

    <!-- @提及浮层 -->
    <div
      v-if="mentionOpen"
      class="absolute bottom-full left-2 z-20 mb-1.5 max-h-44 min-w-40 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
    >
      <template v-if="filteredMentionContacts.length">
        <button
          v-for="c in filteredMentionContacts"
          :key="c.id"
          class="block w-full rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted"
          @mousedown.prevent="selectMentionContact(c)"
        >
          {{ c.name }}
        </button>
      </template>
      <div v-else class="px-2.5 py-2 text-xs text-muted-foreground">无匹配联系人</div>
    </div>

    <!-- 隐藏的文件输入 -->
    <input ref="imageInputRef" type="file" accept="image/*" class="hidden" @change="($event) => $emit('pick-image', $event)" />
    <input ref="fileInputRef" type="file" accept="*/*" class="hidden" @change="($event) => $emit('pick-file', $event)" />

    <!-- 工具行 -->
    <div class="flex items-center gap-0.5 pb-1">
      <Button variant="ghost" size="icon" class="size-7 text-muted-foreground" title="表情" @click="emojiPickerOpen = !emojiPickerOpen">
        <Smile class="size-4" />
      </Button>
      <Button variant="ghost" size="icon" class="size-7 text-muted-foreground" title="图片" :disabled="mediaUploading" @click="imageInputRef?.click()">
        <Image class="size-4" />
      </Button>
      <Button variant="ghost" size="icon" class="size-7 text-muted-foreground" title="文件" :disabled="mediaUploading" @click="fileInputRef?.click()">
        <Paperclip class="size-4" />
      </Button>
      <Button variant="ghost" size="icon" class="size-7 text-muted-foreground" title="素材空间" :disabled="mediaUploading" @click="$emit('open-assets')">
        <Library class="size-4" />
      </Button>
      <span v-if="mediaUploading" class="ml-1.5 animate-pulse text-xs text-muted-foreground">上传中…</span>
    </div>

    <!-- 引用回复预览条 -->
    <div
      v-if="replyTarget"
      class="mb-1 flex items-center gap-1.5 rounded-sm border-l-2 border-primary bg-muted/60 px-2 py-1 text-xs"
    >
      <span class="min-w-0 flex-1 truncate text-muted-foreground">
        回复 {{ replyTarget.actorType === "agent" ? "Agent" : replyTarget.direction === "outbound" ? "人工客服" : "客户" }}：
        {{ replyTarget.text ? (replyTarget.text.length > 50 ? replyTarget.text.slice(0, 50) + "…" : replyTarget.text) : "〔非文本消息〕" }}
      </span>
      <button class="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted" @click="$emit('clear-reply')">
        <X class="size-3" />
      </button>
    </div>

    <Textarea
      ref="textareaRef"
      v-model="text"
      rows="2"
      class="min-h-11 resize-none border-0 bg-transparent px-0 py-1 shadow-none focus-visible:ring-0"
      :placeholder="placeholder"
      :disabled="disabled"
      @focus="emojiPickerOpen = false; $emit('focus-input')"
      @input="onReplyInput"
      @keydown.meta.enter.prevent="$emit('send')"
      @keydown.ctrl.enter.prevent="$emit('send')"
    />
    <div class="flex items-center justify-end gap-2.5">
      <span v-if="isMine" class="text-xs text-muted-foreground">Ctrl / ⌘ + Enter 发送 · 以通道回执为准</span>
      <Button size="sm" class="h-7 min-w-16" :disabled="sending || !canReply" @click="$emit('send')">
        {{ sending ? "已受理" : "发送" }}
      </Button>
    </div>
  </div>
</template>
