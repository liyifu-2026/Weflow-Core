<script setup lang="ts">
/**
 * 设置中心 · ⑥ 安全分区：白名单入口 + 群聊策略（自接待编排页收编）+
 * 审计日志入口。群策略读扩展设置 groupChat 键（Core group-chat-policy 消费）。
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
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
  <div class="wf-section">
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>入口</strong>
      </div>
      <div class="wf-settings-body wf-entry-row">
        <button class="wf-button" @click="router.push('/whitelist')">
          联系人白名单（逐联系人启用/停用 AI）
        </button>
        <button class="wf-button" @click="router.push('/system/audit')">
          审计日志（设置变更 / Handoff / 运营操作）
        </button>
        <button class="wf-button" @click="router.push('/system/users')">
          用户与角色
        </button>
      </div>
    </section>

    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>群聊策略</strong>
        <span class="spacer" />
        <span v-if="notice" class="wf-settings-notice">{{ notice }}</span>
        <span v-if="error" class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-if="loading" class="wf-settings-body">
        <span class="wf-skeleton">正在加载群策略…</span>
      </div>
      <div v-else class="wf-settings-body">
        <p class="wf-settings-hint">
          群聊回复自动简洁（2-3 句）、不含私人信息——系统强制。群聊判定发生在建
          Turn 之前：未命中触发条件的群消息不消耗任何模型调用。判定异常自动回落「仅@」。
        </p>
        <div class="wf-form-row">
          <label>
            <strong>触发模式（何时在群里开口）</strong>
          </label>
          <select v-model="config.mode" class="wf-input">
            <option v-for="option in GROUP_MODE_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}（{{ option.hint }}）
            </option>
          </select>
        </div>
        <div v-if="config.mode === 'mention_or_keyword'" class="wf-form-row">
          <label>
            <strong>响应关键词</strong>
            <span>逗号分隔，命中即回复；请控制数量。</span>
          </label>
          <textarea
            :value="config.keywords.join('，')"
            rows="2"
            class="wf-input"
            placeholder="报价，售后…"
            @input="config.keywords = (($event.target as HTMLTextAreaElement).value ?? '').split(/[，,]/).map((w) => w.trim()).filter(Boolean)"
          />
        </div>
        <template v-if="config.mode === 'accept_all'">
          <div class="wf-form-row">
            <label>
              <strong>响应概率：{{ Math.round(config.probability * 100) }}%</strong>
              <span>每条群消息有此概率回复。</span>
            </label>
            <input
              v-model.number="config.probability"
              type="range"
              min="0"
              max="100"
              step="5"
              style="width: 100%"
            />
          </div>
        </template>
        <template v-if="config.mode !== 'off'">
          <div class="wf-form-row">
            <label>
              <strong>冷却护栏</strong>
              <span>窗口设为 0 = 关闭冷却，防刷屏。</span>
            </label>
            <div class="wf-cooldown">
              <input
                v-model.number="config.cooldownMinutes"
                type="number"
                min="0"
                max="240"
                class="wf-input wf-input-narrow"
              />
              <span>分钟内最多</span>
              <input
                v-model.number="config.maxRepliesPerCooldown"
                type="number"
                min="1"
                max="100"
                class="wf-input wf-input-narrow"
              />
              <span>条</span>
            </div>
          </div>
        </template>
        <div class="wf-form-row">
          <label>
            <strong>群聊附加指令</strong>
            <span>追加到群聊提示词，可留空。</span>
          </label>
          <textarea
            v-model="config.extraInstruction"
            rows="2"
            class="wf-input"
            placeholder="例：本群是售后群，报价问题一律转人工"
          />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>群单独配置</strong>
            <span>格式：群 conversationRef + 模式；覆盖全局策略。</span>
          </label>
          <div class="wf-override-list">
            <div
              v-for="(override, index) in config.groupOverrides"
              :key="override.conversationRef + String(index)"
              class="wf-override-row"
            >
              <input
                v-model="override.conversationRef"
                class="wf-input"
                placeholder="12345678@chatroom"
              />
              <select v-model="override.mode" class="wf-input">
                <option v-for="option in GROUP_MODE_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
              <button
                class="wf-button compact danger"
                @click="config.groupOverrides.splice(index, 1)"
              >
                删除
              </button>
              <input
                v-if="override.mode === 'mention_or_keyword'"
                class="wf-input wf-override-keywords"
                placeholder="该群关键词，逗号分隔"
                :value="override.keywords.join('，')"
                @input="override.keywords = (($event.target as HTMLInputElement).value ?? '').split(/[，,]/).map((w) => w.trim()).filter(Boolean)"
              />
            </div>
            <button
              class="wf-button compact"
              @click="config.groupOverrides.push({ conversationRef: '', mode: 'mention_or_keyword', keywords: [] })"
            >
              + 添加群覆盖
            </button>
          </div>
        </div>
        <div class="wf-form-actions">
          <button class="wf-button primary" :disabled="saving" @click="save">
            {{ saving ? "保存中…" : "保存群策略" }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
.wf-entry-row {
  flex-direction: row;
  flex-wrap: wrap;
}
.wf-cooldown {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--wf-text-secondary, #5f6368);
}
.wf-cooldown .wf-input-narrow {
  width: 72px;
}
.wf-override-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wf-override-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
}
.wf-override-keywords {
  grid-column: 1 / -1;
}
</style>
