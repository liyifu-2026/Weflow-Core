<script setup lang="ts">
/**
 * 设置中心 · ① AI员工分区：员工管理入口 + 行为参数。
 * 行为参数（R2）：会话 TTL/轮数上限/wait 上限/nudge 话术/ReAct 预算，
 * 存扩展设置 behavior 键，agent-worker 30s TTL 缓存热读，无需重启。
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  readPipelineSettings,
  writePipelineSettings,
} from "./common";

const router = useRouter();

type BehaviorConfig = {
  sessionTtlMinutes: number;
  sessionRoundBudget: number;
  defaultWaitMs: number;
  nudgeText: string;
  toolStepBudget: number;
};

const DEFAULTS: BehaviorConfig = {
  sessionTtlMinutes: 45,
  sessionRoundBudget: 24,
  defaultWaitMs: 300_000,
  nudgeText: "",
  toolStepBudget: 4,
};

const config = ref<BehaviorConfig>({ ...DEFAULTS });
const rawSettings = ref<Record<string, unknown>>({});
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");

function applyBehavior(raw: unknown) {
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  config.value = {
    sessionTtlMinutes: num(source.sessionTtlMinutes, DEFAULTS.sessionTtlMinutes),
    sessionRoundBudget: num(
      source.sessionRoundBudget,
      DEFAULTS.sessionRoundBudget,
    ),
    defaultWaitMs: num(source.defaultWaitMs, DEFAULTS.defaultWaitMs),
    nudgeText:
      typeof source.nudgeText === "string" ? source.nudgeText : DEFAULTS.nudgeText,
    toolStepBudget: num(source.toolStepBudget, DEFAULTS.toolStepBudget),
  };
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rawSettings.value = await readPipelineSettings();
    applyBehavior(rawSettings.value.behavior);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "行为参数加载失败";
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
      behavior: { ...config.value },
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
        <strong>AI 员工</strong>
        <button class="wf-button compact" @click="router.push('/ai-employees')">
          管理员工（Prompt / 版本 / 联系人绑定）
        </button>
      </div>
      <div class="wf-settings-body">
        <p class="wf-settings-hint">
          人格（Prompt 版本）、分工（联系人绑定）、能力（工具开关）在员工管理页维护；
          未绑定联系人的会话走默认员工。模式说明：深思模式 = ReAct 预算
          {{ config.toolStepBudget }} 步 + 思维链展示；直答模式 = 预算 1（预判分流 simple 档直答）。
        </p>
      </div>
    </section>

    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>行为参数</strong>
        <span v-if="notice" class="wf-settings-notice">{{ notice }}</span>
        <span v-if="error" class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-if="loading" class="wf-settings-body">
        <span class="wf-skeleton">正在加载行为参数…</span>
      </div>
      <div v-else class="wf-settings-body">
        <div class="wf-form-row">
          <label>
            <strong>会话 TTL（分钟）</strong>
            <span>会话片段超时强制收束的分钟数（默认 45）。</span>
          </label>
          <input
            v-model.number="config.sessionTtlMinutes"
            type="number"
            min="5"
            max="1440"
            class="wf-input wf-input-narrow"
          />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>每会话轮数上限</strong>
            <span>预算耗尽强制收束，防「永不结束的会话」（默认 24）。</span>
          </label>
          <input
            v-model.number="config.sessionRoundBudget"
            type="number"
            min="1"
            max="200"
            class="wf-input wf-input-narrow"
          />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>wait 缺省等待（秒）</strong>
            <span>模型未指定等待时长时的缺省值，30~900 秒（默认 300）。</span>
          </label>
          <input
            :value="Math.round(config.defaultWaitMs / 1000)"
            type="number"
            min="30"
            max="900"
            class="wf-input wf-input-narrow"
            @input="config.defaultWaitMs = Number(($event.target as HTMLInputElement).value || '300') * 1000"
          />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>ReAct 工具步数预算</strong>
            <span>单个 Turn 内最大工具步数（深思模式预算；默认 4）。</span>
          </label>
          <input
            v-model.number="config.toolStepBudget"
            type="number"
            min="1"
            max="12"
            class="wf-input wf-input-narrow"
          />
        </div>
        <div class="wf-form-row">
          <label>
            <strong>wait 超时 nudge 话术</strong>
            <span>留空 = 不代发（模型自带 nudge 优先）。配置后唤醒超时由代码直发该话术，不开模型。</span>
          </label>
          <textarea
            v-model="config.nudgeText"
            rows="2"
            class="wf-input"
            placeholder="例：还在吗？请问还有其他问题吗？"
          />
        </div>
        <div class="wf-form-actions">
          <button class="wf-button primary" :disabled="saving" @click="save">
            {{ saving ? "保存中…" : "保存行为参数" }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
</style>
