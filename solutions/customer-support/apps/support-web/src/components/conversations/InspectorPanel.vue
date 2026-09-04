<script setup lang="ts">
/**
 * Inspector 上下文面板：当前上下文 / 交接说明 / 回答依据 / 客户资料 / 历史对话
 * 五个视图的内容。替代旧 WfInspector 内联模板；仍用 WfInspector 外壳
 * （AuditView 等共享组件不属于本批边界，外壳在第 6 批统一处理）。
 */
import { ref, watch } from "vue";
import { api } from "../../api";
import { useWeflowAuthStore } from "../../auth-store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import WfInspector from "../../components/WfInspector.vue";
import MediaImage from "../../components/MediaImage.vue";
import MediaFile from "../../components/MediaFile.vue";
import VoiceMessage from "../../components/VoiceMessage.vue";
import AvatarImage from "../../components/AvatarImage.vue";
import { contactDisplayName, factLabel, reasonLabel } from "../../labels";
import {
  cycleStatusLabel,
  isFileMessage,
  isImageMessage,
  isVoiceMsg,
  messageTime,
  riskLabel,
  type Conversation,
  type Evidence,
  type Message,
} from "../conversations/types";

const props = defineProps<{
  open: boolean;
  view: "context" | "brief" | "evidence" | "customer" | "history";
  title: string;
  depth: number;
  selected: Conversation | null;
  company: string;
  handoff: any;
  evidence: Evidence[];
  ownershipLabel: string;
  briefingLine: string;
  confirmedFactsLine: string;
  unresolvedShort: string[];
  agentSession: { state: string; roundsUsed: number; roundBudget: number } | null;
  sessionBadgeLabel: string | null;
  pendingWake: { wakeId: number; turnId: string; wakeAt: string; nudgeText?: string | null } | null;
  doneWakes: Array<{ wakeId: number; turnId: string; wakeAt: string; nudgeText?: string | null }>;
  wakeCountdown: string;
  lastReplyTurnId: string | null;
  risk: string | null;
  /** 客户资料编辑 */
  note: string;
  tags: string;
  /** 历史对话 */
  historySelectedId: string;
  historyLoading: boolean;
  historyConversations: Array<{ conversationId: string; latestMessageAt: string | null; latestMessageText?: string | null; handoffStatus?: string | null }>;
  historyNextCursor: string | null;
  historyMessages: Message[];
  historyMessagesLoading: boolean;
  historyMessagesNextCursor: string | null;
}>();

const emit = defineEmits<{
  close: [];
  back: [];
  "open-view": [view: "context" | "brief" | "evidence" | "customer" | "history"];
  "open-evidence": [item: Evidence];
  "search-knowledge": [];
  "open-trace": [turnId: string];
  "update:note": [value: string];
  "update:tags": [value: string];
  "save-profile": [];
  "open-history-conversation": [id: string];
  "load-history-more": [];
  "load-history-messages-more": [];
}>();

const auth = useWeflowAuthStore();

// 定时消息（SCHEDULED-SEND-PLAN）：待发/待审/最近作废项进入上下文面板，
// 人工客服在会话详情即可知晓 agent 的既定承诺。
const scheduledSends = ref<
  Array<{
    scheduledSendId: string;
    content: string;
    status: "pending" | "fired" | "cancelled" | "frozen";
    sendAt: string;
    cancelReason: string | null;
  }>
>([]);

async function loadScheduledSends() {
  const conversationId = props.selected?.conversationId;
  if (!conversationId || !props.open) {
    scheduledSends.value = [];
    return;
  }
  try {
    const result = await api<{
      scheduledSends: Array<{
        scheduledSendId: string;
        content: string;
        status: "pending" | "fired" | "cancelled" | "frozen";
        sendAt: string;
        cancelReason: string | null;
      }>;
    }>(`/api/v1/conversations/${encodeURIComponent(conversationId)}/scheduled-sends`);
    scheduledSends.value = result.scheduledSends.filter(
      (item) => item.status !== "fired",
    );
  } catch {
    scheduledSends.value = [];
  }
}

watch(
  () => [props.open, props.view, props.selected?.conversationId] as const,
  ([open, view]) => {
    if (open && view === "context") void loadScheduledSends();
  },
  { immediate: true },
);

function scheduledStatusLabel(status: ScheduledSendStatus): string {
  if (status === "pending") return "待发送";
  if (status === "frozen") return "待审";
  return "已作废";
}

type ScheduledSendStatus = "pending" | "fired" | "cancelled" | "frozen";
const note = defineModel<string>("note", { default: "" });
const tags = defineModel<string>("tags", { default: "" });

function historyActorLabel(message: Message) {
  return message.actorType === "agent"
    ? "Agent"
    : message.direction === "outbound"
      ? "人工客服"
      : "客户";
}
</script>

<template>
  <WfInspector
    :open="open"
    :title="title"
    :depth="depth"
    @close="emit('close')"
    @back="emit('back')"
  >
    <!-- 当前上下文 -->
    <template v-if="view === 'context'">
      <section class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">当前任务</span>
        <p class="m-0 leading-relaxed">{{ ownershipLabel }}</p>
        <p v-if="handoff && handoff.state?.status !== 'resolved'" class="mt-1 text-sm text-muted-foreground">
          Agent 已暂停自动回复
        </p>
      </section>
      <section v-if="agentSession && agentSession.state !== 'closed'" class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">会话状态</span>
        <p class="m-0 leading-relaxed">
          <Badge :variant="agentSession.state === 'waiting' ? 'outline' : 'secondary'">{{ sessionBadgeLabel }}</Badge>
        </p>
        <p v-if="pendingWake" class="mt-1 text-xs text-muted-foreground">
          等待客户回复，超时（{{ wakeCountdown }}）后{{ pendingWake.nudgeText ? "自动发送提醒" : "自动唤醒跟进" }}
        </p>
        <p
          v-for="done in doneWakes.slice(0, 2)"
          :key="done.wakeId"
          class="mt-1 text-xs text-muted-foreground opacity-75"
        >
          已于 {{ messageTime(done.wakeAt) }} {{ done.nudgeText ? "发送提醒" : "唤醒跟进" }}
        </p>
        <Button
          v-if="lastReplyTurnId"
          variant="link"
          size="sm"
          class="mt-1 h-auto p-0 text-xs"
          @click="emit('open-trace', lastReplyTurnId)"
        >
          查看最近决策轨迹 →
        </Button>
      </section>
      <section v-if="scheduledSends.length" class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">定时消息</span>
        <div v-for="item in scheduledSends" :key="item.scheduledSendId" class="mt-1 first:mt-0">
          <p class="m-0 flex items-center gap-2 leading-relaxed">
            <Badge :variant="item.status === 'pending' ? 'secondary' : item.status === 'frozen' ? 'destructive' : 'outline'">
              {{ scheduledStatusLabel(item.status) }}
            </Badge>
            <span class="text-xs text-muted-foreground">原定 {{ messageTime(item.sendAt) }}</span>
          </p>
          <p class="m-0 text-sm leading-relaxed">{{ item.content }}</p>
          <p v-if="item.status === 'cancelled' && item.cancelReason === 'new_inbound'" class="m-0 text-xs text-muted-foreground">
            因用户新消息作废，AI 将在回复中处理
          </p>
        </div>
      </section>
      <section
        v-if="handoff"
        class="-mx-2 cursor-pointer rounded-md border-b border-border px-2 py-4 transition-colors hover:bg-muted/50"
        role="button"
        tabindex="0"
        @click="emit('open-view', 'brief')"
        @keyup.enter="emit('open-view', 'brief')"
      >
        <span class="mb-1 block text-xs font-bold text-muted-foreground">交接摘要</span>
        <p class="m-0 leading-relaxed">{{ briefingLine }}</p>
        <span class="mt-1 inline-block text-xs text-muted-foreground">查看完整摘要 →</span>
      </section>
      <section
        v-if="handoff?.briefing?.confirmedFacts?.length || unresolvedShort.length"
        class="-mx-2 cursor-pointer rounded-md border-b border-border px-2 py-4 transition-colors hover:bg-muted/50"
        role="button"
        tabindex="0"
        @click="emit('open-view', 'brief')"
        @keyup.enter="emit('open-view', 'brief')"
      >
        <span class="mb-1 block text-xs font-bold text-muted-foreground">关键事实</span>
        <p class="m-0 leading-relaxed">
          {{ confirmedFactsLine }}<span v-if="unresolvedShort.length"> · 仍需确认：{{ unresolvedShort.join("、") }}</span>
        </p>
      </section>
      <section
        class="-mx-2 cursor-pointer rounded-md border-b border-border px-2 py-4 transition-colors hover:bg-muted/50"
        role="button"
        tabindex="0"
        @click="emit('open-view', 'evidence')"
        @keyup.enter="emit('open-view', 'evidence')"
      >
        <span class="mb-1 block text-xs font-bold text-muted-foreground">依据</span>
        <p class="m-0 leading-relaxed">
          {{ evidence.length ? `${evidence.length} 条回答依据` : "尚无可展示的回答依据" }}
        </p>
        <span class="mt-1 inline-block text-xs text-muted-foreground">查看依据 →</span>
      </section>
      <section
        v-if="selected"
        class="-mx-2 cursor-pointer rounded-md border-b border-border px-2 py-4 transition-colors hover:bg-muted/50"
        role="button"
        tabindex="0"
        @click="emit('open-view', 'customer')"
        @keyup.enter="emit('open-view', 'customer')"
      >
        <span class="mb-1 block text-xs font-bold text-muted-foreground">联系人</span>
        <p class="m-0 leading-relaxed">{{ contactDisplayName(selected) }}</p>
        <span class="mt-1 inline-block text-xs text-muted-foreground">查看资料 →</span>
      </section>
      <section
        v-if="handoff?.cycles?.length"
        class="-mx-2 cursor-pointer rounded-md px-2 py-4 transition-colors hover:bg-muted/50"
        role="button"
        tabindex="0"
        @click="emit('open-view', 'brief')"
        @keyup.enter="emit('open-view', 'brief')"
      >
        <span class="mb-1 block text-xs font-bold text-muted-foreground">交接历史</span>
        <p class="m-0 leading-relaxed">{{ handoff.cycles.length }} 次交接</p>
      </section>
    </template>

    <!-- 交接说明 -->
    <template v-else-if="view === 'brief' && handoff">
      <section class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">为什么需要人工</span>
        <p class="m-0 leading-relaxed">{{ handoff.briefing?.problemSummary || "客户需要人工继续处理当前问题。" }}</p>
      </section>
      <section v-if="handoff.briefing?.confirmedFacts?.length" class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">已确认</span>
        <p class="m-0 leading-relaxed">
          {{ handoff.briefing.confirmedFacts.map((fact: any) => factLabel(fact)).join(" · ") }}
        </p>
      </section>
      <section v-if="handoff.briefing?.unresolvedItems?.length" class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">仍需确认</span>
        <p class="m-0 leading-relaxed">{{ handoff.briefing.unresolvedItems.join("；") }}</p>
      </section>
      <section class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">当前风险</span>
        <span
          class="text-xs"
          :class="risk === 'high' ? 'font-semibold text-destructive' : 'text-muted-foreground'"
        >{{ riskLabel(risk) }}</span>
      </section>
      <section class="border-b border-border py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">处理归属</span>
        <p class="m-0 leading-relaxed">{{ ownershipLabel }}</p>
      </section>
      <section v-if="handoff.cycles?.length" class="py-4">
        <span class="mb-1 block text-xs font-bold text-muted-foreground">交接历史</span>
        <div class="mt-2 space-y-3">
          <div v-for="cycle in [...handoff.cycles].reverse()" :key="cycle.cycleId" class="flex gap-2.5">
            <span class="mt-1.5 size-2 shrink-0 rounded-full border border-border bg-muted" />
            <div class="min-w-0 text-sm">
              <strong>{{ cycleStatusLabel(cycle.status) }}</strong>
              <div class="text-xs text-muted-foreground">
                <div>{{ new Date(cycle.createdAt).toLocaleString() }}</div>
                <div v-if="cycle.reason">{{ reasonLabel(cycle.reason) || cycle.reason }}</div>
                <div v-if="cycle.result === 'transferred'">已转交</div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- 回答依据 -->
    <template v-else-if="view === 'evidence'">
      <template v-if="evidence.length">
        <button
          v-for="item in evidence"
          :key="item.evidenceId"
          class="block w-full border-b border-border py-3 text-left"
          role="button"
          tabindex="0"
          @click="emit('open-evidence', item)"
          @keyup.enter="emit('open-evidence', item)"
        >
          <strong class="text-sm">{{ item.title || item.sourceName || "知识证据" }}</strong>
          <span class="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {{ item.provenance === "agent_retrieval" ? "Agent 最近检索 · " : "客服固定依据 · " }}{{ item.excerpt || "暂无摘要" }}
          </span>
        </button>
        <Button variant="link" size="sm" class="mt-2 h-auto p-0" @click="emit('search-knowledge')">
          检索更多知识
        </Button>
      </template>
      <p v-else class="py-2 text-sm text-muted-foreground">
        当前会话暂时没有可展示的回答依据。
        <button class="text-primary underline-offset-4 hover:underline" @click="emit('search-knowledge')">检索知识</button>
      </p>
    </template>

    <!-- 客户资料 -->
    <template v-else-if="view === 'customer' && selected">
      <div class="flex flex-col items-start gap-1 py-4">
        <AvatarImage
          :contact-id="selected.contact?.contactId"
          :fallback-text="contactDisplayName(selected)"
          :size="40"
        />
        <h3 class="m-0 text-lg font-semibold tracking-tight">{{ contactDisplayName(selected) }}</h3>
        <p v-if="company" class="m-0 text-sm text-muted-foreground">{{ company }}</p>
        <p v-if="selected.contact?.agentEnabled === false" class="m-0 text-sm text-muted-foreground">
          Agent 自动回复已暂停
        </p>
      </div>
      <section class="space-y-3 border-b border-border py-4">
        <div class="space-y-1.5">
          <Label for="customer-note">内部备注</Label>
          <Textarea id="customer-note" v-model="note" :rows="3" />
        </div>
        <div class="space-y-1.5">
          <Label for="customer-tags">标签</Label>
          <Input id="customer-tags" v-model="tags" placeholder="用顿号或逗号分隔" />
        </div>
        <Button @click="emit('save-profile')">保存资料</Button>
      </section>
      <section
        class="-mx-2 cursor-pointer rounded-md px-2 py-4 transition-colors hover:bg-muted/50"
        role="button"
        tabindex="0"
        @click="emit('open-view', 'history')"
        @keyup.enter="emit('open-view', 'history')"
      >
        <span class="mb-1 block text-xs font-bold text-muted-foreground">历史对话</span>
        <p class="m-0 text-sm leading-relaxed">查看该联系人的历史会话（只读）</p>
        <span class="mt-1 inline-block text-xs text-muted-foreground">查看历史 →</span>
      </section>
    </template>

    <!-- 历史对话 -->
    <template v-else-if="view === 'history'">
      <template v-if="historySelectedId">
        <div class="flex items-center justify-between gap-2 py-3">
          <Button variant="link" size="sm" class="h-auto p-0" @click="emit('back')">
            ← 全部历史
          </Button>
          <span class="text-xs text-muted-foreground">{{ selected ? contactDisplayName(selected) : "" }} 的历史消息</span>
        </div>
        <div class="border-y border-border py-1.5 text-xs text-muted-foreground">历史记录 · 只读</div>
        <Skeleton v-if="historyMessagesLoading" class="mt-3 h-4 w-2/3" />
        <div v-else class="flex flex-col gap-3 py-3">
          <div
            v-for="message in historyMessages"
            :key="message.messageId"
            class="flex flex-col gap-0.5"
            :class="message.direction === 'outbound' ? 'items-end' : ''"
          >
            <span class="text-xs text-muted-foreground">{{ historyActorLabel(message) }}</span>
            <template v-if="isImageMessage(message) && message.mediaId">
              <MediaImage
                :media-id="message.mediaId"
                :alt="`${historyActorLabel(message)} 发送的图片`"
                class="max-h-[240px] max-w-[240px] rounded-lg object-cover"
              />
            </template>
            <template v-else-if="isFileMessage(message) && message.mediaId">
              <MediaFile :media-id="message.mediaId" :file-name="message.mediaFileName" />
            </template>
            <template v-else-if="isVoiceMsg(message) && message.mediaId">
              <VoiceMessage :media-id="message.mediaId" :alt="`${historyActorLabel(message)} 发送的语音`" />
            </template>
            <p v-else class="m-0 whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 text-sm">{{ message.text || "〔非文本消息〕" }}</p>
            <span class="text-xs text-muted-foreground">{{ new Date(message.occurredAt).toLocaleString() }}</span>
          </div>
        </div>
        <Button
          v-if="historyMessagesNextCursor"
          variant="link"
          size="sm"
          class="h-auto p-0"
          :disabled="historyMessagesLoading"
          @click="emit('load-history-messages-more')"
        >
          加载更早消息
        </Button>
      </template>
      <template v-else>
        <div class="border-b border-border py-1.5 text-xs text-muted-foreground">历史记录 · 只读（不可接管或回复）</div>
        <Skeleton v-if="historyLoading" class="mt-3 h-4 w-2/3" />
        <div v-else-if="historyConversations.length" class="flex flex-col py-2">
          <button
            v-for="item in historyConversations"
            :key="item.conversationId"
            class="flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50"
            :class="{ 'bg-muted': item.conversationId === historySelectedId }"
            @click="emit('open-history-conversation', item.conversationId)"
          >
            <span class="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
              {{ item.latestMessageAt ? new Date(item.latestMessageAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—" }}
            </span>
            <span class="min-w-0 flex-1 truncate text-sm">{{
              item.latestMessageText
                ? /^user_[A-Za-z0-9]+$/.test(item.latestMessageText.trim())
                  ? "消息内容暂不可见"
                  : item.latestMessageText
                : "暂无消息"
            }}</span>
            <span v-if="item.conversationId === historySelectedId" class="shrink-0 text-xs text-muted-foreground">当前</span>
          </button>
          <Button
            v-if="historyNextCursor"
            variant="link"
            size="sm"
            class="mx-auto mt-2 h-auto p-0"
            :disabled="historyLoading"
            @click="emit('load-history-more')"
          >
            加载更多
          </Button>
        </div>
        <p v-else class="py-3 text-sm text-muted-foreground">该联系人暂无其他会话。</p>
      </template>
    </template>
  </WfInspector>
</template>
