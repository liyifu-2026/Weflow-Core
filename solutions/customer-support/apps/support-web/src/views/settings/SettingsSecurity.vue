<script setup lang="ts">
/**
 * 设置中心 · ⑥ 安全分区：白名单入口 + 群聊策略（自接待编排页收编）+
 * 审计日志入口。群策略读扩展设置 groupChat 键（Core group-chat-policy 消费）。
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { CircleAlert, CircleCheck, Plus, Trash2 } from "lucide-vue-next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  readPipelineSettings,
  writePipelineSettings,
} from "./common";

const router = useRouter();

type GroupChatMode =
  | "mention_only"
  | "mention_or_keyword"
  | "accept_all"
  | "off";

type GroupOverride = {
  conversationRef: string;
  mode: GroupChatMode;
  keywords: string[];
};

type GroupChatConfig = {
  mode: GroupChatMode;
  keywords: string[];
  cooldownMinutes: number;
  maxRepliesPerCooldown: number;
  probability: number;
  extraInstruction: string;
  groupOverrides: GroupOverride[];
};

const DEFAULT_GROUP_CHAT: GroupChatConfig = {
  mode: "mention_only",
  keywords: [],
  cooldownMinutes: 0,
  maxRepliesPerCooldown: 2,
  probability: 0,
  extraInstruction: "",
  groupOverrides: [],
};

const GROUP_MODE_OPTIONS: Array<{
  value: GroupChatMode;
  label: string;
  hint: string;
}> = [
  { value: "mention_only", label: "仅被 @ 时回复", hint: "最保守，免打扰友好" },
  { value: "mention_or_keyword", label: "@ 或关键词", hint: "可控，推荐" },
  { value: "accept_all", label: "全部响应", hint: "易刷屏，需配合概率/冷却" },
  { value: "off", label: "关闭（全群静默）", hint: "所有群不响应" },
];

const ENTRY_LINKS: Array<{ label: string; desc: string; to: string }> = [
  { label: "联系人白名单", desc: "逐联系人启用/停用 AI", to: "/whitelist" },
  { label: "审计日志", desc: "设置变更 / Handoff / 运营操作", to: "/system/audit" },
  { label: "用户与角色", desc: "账号与权限管理", to: "/system/users" },
];

const modeLabel = (value: GroupChatMode) =>
  GROUP_MODE_OPTIONS.find((option) => option.value === value)?.label ?? value;

const config = ref<GroupChatConfig>(JSON.parse(JSON.stringify(DEFAULT_GROUP_CHAT)));
const rawSettings = ref<Record<string, unknown>>({});
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");

function applyGroupChat(raw: unknown) {
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const mode = source.mode;
  const modeValue: GroupChatMode =
    mode === "mention_only" ||
    mode === "mention_or_keyword" ||
    mode === "accept_all" ||
    mode === "off"
      ? mode
      : DEFAULT_GROUP_CHAT.mode;
  const overridesRaw = Array.isArray(source.groupOverrides)
    ? source.groupOverrides
    : [];
  config.value = {
    mode: modeValue,
    keywords: Array.isArray(source.keywords)
      ? source.keywords.filter(
          (word): word is string => typeof word === "string" && word.trim() !== "",
        )
      : [],
    cooldownMinutes:
      typeof source.cooldownMinutes === "number" &&
      Number.isFinite(source.cooldownMinutes)
        ? Math.round(source.cooldownMinutes)
        : DEFAULT_GROUP_CHAT.cooldownMinutes,
    maxRepliesPerCooldown:
      typeof source.maxRepliesPerCooldown === "number" &&
      Number.isFinite(source.maxRepliesPerCooldown)
        ? Math.round(source.maxRepliesPerCooldown)
        : DEFAULT_GROUP_CHAT.maxRepliesPerCooldown,
    probability:
      typeof source.probability === "number" &&
      Number.isFinite(source.probability)
        ? source.probability
        : DEFAULT_GROUP_CHAT.probability,
    extraInstruction:
      typeof source.extraInstruction === "string"
        ? source.extraInstruction
        : "",
    groupOverrides: overridesRaw.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const o = item as Record<string, unknown>;
      const ref = typeof o.conversationRef === "string" ? o.conversationRef.trim() : "";
      const oMode = o.mode;
      const oModeValue: GroupChatMode | null =
        oMode === "mention_only" ||
        oMode === "mention_or_keyword" ||
        oMode === "accept_all" ||
        oMode === "off"
          ? oMode
          : null;
      if (ref === "" || oModeValue === null) return [];
      return [
        {
          conversationRef: ref,
          mode: oModeValue,
          keywords: Array.isArray(o.keywords)
            ? o.keywords.filter(
                (word): word is string =>
                  typeof word === "string" && word.trim() !== "",
              )
            : [],
        },
      ];
    }),
  };
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rawSettings.value = await readPipelineSettings();
    applyGroupChat(rawSettings.value.groupChat);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "群策略加载失败";
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    await writePipelineSettings({
      ...rawSettings.value,
      groupChat: { ...config.value },
    });
    notice.value = "已保存；30 秒内生效（无需重启）";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <!-- 入口 -->
    <Card>
      <CardHeader>
        <CardTitle>入口</CardTitle>
      </CardHeader>
      <CardContent class="flex flex-wrap gap-2">
        <Button
          v-for="link in ENTRY_LINKS"
          :key="link.to"
          variant="outline"
          @click="router.push(link.to)"
        >
          {{ link.label }}
          <span class="text-muted-foreground">{{ link.desc }}</span>
        </Button>
      </CardContent>
    </Card>

    <!-- 群聊策略 -->
    <Card>
      <CardHeader>
        <CardTitle>群聊策略</CardTitle>
        <CardDescription>
          群聊回复自动简洁（2-3 句）、不含私人信息——系统强制。群聊判定发生在建
          Turn 之前：未命中触发条件的群消息不消耗任何模型调用。判定异常自动回落「仅@」。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="loading" class="space-y-4">
          <Skeleton v-for="n in 5" :key="n" class="h-9 w-full" />
        </div>
        <form v-else class="space-y-5" @submit.prevent="save">
          <Alert v-if="error" variant="destructive">
            <CircleAlert class="size-4" />
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
          <p
            v-if="notice && !error"
            class="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <CircleCheck class="size-4" />
            {{ notice }}
          </p>

          <div class="space-y-2">
            <Label for="group-mode">触发模式（何时在群里开口）</Label>
            <Select v-model="config.mode">
              <SelectTrigger id="group-mode" class="w-full sm:max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="option in GROUP_MODE_OPTIONS"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}（{{ option.hint }}）
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="config.mode === 'mention_or_keyword'" class="space-y-2">
            <Label for="group-keywords">响应关键词</Label>
            <Textarea
              id="group-keywords"
              :value="config.keywords.join('，')"
              rows="2"
              placeholder="报价，售后…"
              @input="
                config.keywords = (($event.target as HTMLTextAreaElement).value ?? '')
                  .split(/[，,]/)
                  .map((w) => w.trim())
                  .filter(Boolean)
              "
            />
            <p class="text-xs text-muted-foreground">
              逗号分隔，命中即回复；请控制数量。
            </p>
          </div>

          <div v-if="config.mode === 'accept_all'" class="space-y-2">
            <Label for="group-probability">
              响应概率：{{ Math.round(config.probability * 100) }}%
            </Label>
            <input
              id="group-probability"
              v-model.number="config.probability"
              type="range"
              min="0"
              max="100"
              step="5"
              class="w-full accent-[var(--primary)]"
            />
            <p class="text-xs text-muted-foreground">每条群消息有此概率回复。</p>
          </div>

          <div v-if="config.mode !== 'off'" class="space-y-2">
            <Label>冷却护栏</Label>
            <div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Input
                v-model.number="config.cooldownMinutes"
                type="number"
                min="0"
                max="240"
                class="w-20"
              />
              <span>分钟内最多</span>
              <Input
                v-model.number="config.maxRepliesPerCooldown"
                type="number"
                min="1"
                max="100"
                class="w-20"
              />
              <span>条</span>
            </div>
            <p class="text-xs text-muted-foreground">窗口设为 0 = 关闭冷却，防刷屏。</p>
          </div>

          <div class="space-y-2">
            <Label for="group-extra">群聊附加指令</Label>
            <Textarea
              id="group-extra"
              v-model="config.extraInstruction"
              rows="2"
              placeholder="例：本群是售后群，报价问题一律转人工"
            />
            <p class="text-xs text-muted-foreground">追加到群聊提示词，可留空。</p>
          </div>

          <div class="space-y-2">
            <Label>群单独配置</Label>
            <p class="text-xs text-muted-foreground">
              格式：群 conversationRef + 模式；覆盖全局策略。
            </p>
            <div class="space-y-3">
              <div
                v-for="(override, index) in config.groupOverrides"
                :key="override.conversationRef + String(index)"
                class="grid gap-2 rounded-md border p-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]"
              >
                <Input
                  v-model="override.conversationRef"
                  placeholder="12345678@chatroom"
                />
                <Select v-model="override.mode">
                  <SelectTrigger class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      v-for="option in GROUP_MODE_OPTIONS"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ modeLabel(option.value) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="text-destructive hover:text-destructive"
                  title="删除该群覆盖"
                  @click="config.groupOverrides.splice(index, 1)"
                >
                  <Trash2 class="size-4" />
                </Button>
                <Input
                  v-if="override.mode === 'mention_or_keyword'"
                  class="sm:col-span-3"
                  placeholder="该群关键词，逗号分隔"
                  :value="override.keywords.join('，')"
                  @input="
                    override.keywords = (($event.target as HTMLInputElement).value ?? '')
                      .split(/[，,]/)
                      .map((w) => w.trim())
                      .filter(Boolean)
                  "
                />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              @click="
                config.groupOverrides.push({
                  conversationRef: '',
                  mode: 'mention_or_keyword',
                  keywords: [],
                })
              "
            >
              <Plus class="size-4" />
              添加群覆盖
            </Button>
          </div>

          <div>
            <Button type="submit" :disabled="saving">
              {{ saving ? "保存中…" : "保存群策略" }}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
