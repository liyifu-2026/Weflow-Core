<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

/**
 * AI 链路配置页（业务 UI，经 Console ExtensionHost 挂载于 /support/pipeline）。
 *
 * 以分层路由图展示「入库 → 预判分流 → 转人工/直答/主力 → 发送闸门」链路，
 * 点击节点在右侧抽屉中编辑分流策略；主力模型等平台资源只读展示并跳转
 * 系统设置。配置存储走 Core 通用扩展设置路由，Core 执行侧（agent-worker）
 * 以相同 JSON 形状消费。
 */

type TriageConfig = {
  enabled: boolean;
  riskKeywords: string[];
  llmClassifyEnabled: boolean;
  timeoutMs: number;
  allowDirectReply: boolean;
};

const DEFAULT_PIPELINE = {
  triage: {
    enabled: false,
    riskKeywords: [] as string[],
    llmClassifyEnabled: true,
    timeoutMs: 3000,
    allowDirectReply: false,
  } as TriageConfig,
};

const SETTINGS_URL =
  "/api/v1/admin/solutions/weflow.customer-support/extensions/support-pipeline/settings";

const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");
const pipeline = ref(cloneDefaults());
/** 平台级当前主力/分流/直答模型名（仅展示） */
const modelNames = ref<{ text?: string; triage?: string; fast?: string }>({});

/** 展开中的节点 id；null = 抽屉关闭 */
const openNode = ref<string | null>(null);
const keywordsText = ref("");

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_PIPELINE)) as typeof DEFAULT_PIPELINE;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
  });
  if (!response.ok) throw new Error(`请求失败 ${String(response.status)}`);
  return (await response.json()) as T;
}

async function loadAll() {
  loading.value = true;
  error.value = "";
  try {
    const [settings, models] = await Promise.all([
      api<{ settings: unknown }>(SETTINGS_URL),
      api<{
        settings: {
          textModel: { name: string };
          triageModel?: { name: string };
          fastModel?: { name: string };
        };
      }>("/api/v1/admin/model-settings").catch(() => undefined),
    ]);
    // 存储形状：{ pipeline: { triage: {...} } }
    const pipe = ((settings as { settings?: Record<string, unknown> }).settings as
      | { pipeline?: { triage?: Partial<TriageConfig> } }
      | undefined)?.pipeline;
    pipeline.value = {
      triage: { ...DEFAULT_PIPELINE.triage, ...(pipe?.triage ?? {}) },
    };
    if (models) {
      modelNames.value = {
        text: models.settings.textModel?.name,
        triage: models.settings.triageModel?.name,
        fast: models.settings.fastModel?.name,
      };
    }
    keywordsText.value = (pipeline.value.triage.riskKeywords ?? []).join("，");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
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
    pipeline.value.triage.riskKeywords = keywordsText.value
      .split(/[，,]/)
      .map((word) => word.trim())
      .filter(Boolean);
    await api(SETTINGS_URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { pipeline: pipeline.value } }),
    });
    notice.value = "已保存；30 秒内生效（无需重启）";
    // 回读以确认落库
    const readback = await api<{ settings: unknown }>(SETTINGS_URL);
    const pipe = ((readback as { settings?: Record<string, unknown> }).settings as
      | { pipeline?: { triage?: Partial<TriageConfig> } }
      | undefined)?.pipeline;
    pipeline.value = {
      triage: { ...DEFAULT_PIPELINE.triage, ...(pipe?.triage ?? {}) },
    };
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

const triageActive = computed(() => pipeline.value.triage.enabled);
const directEnabled = computed(
  () => triageActive.value && pipeline.value.triage.allowDirectReply,
);

function toggleNode(nodeId: string) {
  openNode.value = openNode.value === nodeId ? null : nodeId;
}
</script>

<template>
  <div class="pl-page">
    <header class="pl-header">
      <h1>AI 链路配置</h1>
      <p class="pl-sub">
        分层决策与消息路由总览 · 点击节点展开配置 · 兜底原则：任何判定异常自动回落主流程
      </p>
    </header>

    <div v-if="loading" class="pl-loading">加载中…</div>

    <template v-else>
      <!-- 链路图 -->
      <section class="wf-panel pl-graph-panel">
        <svg class="pl-wires" aria-hidden="true">
          <defs>
            <marker id="pl-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#9aa5b1" />
            </marker>
          </defs>
        </svg>
        <div class="pl-row pl-mainline">
          <div class="pl-node pl-fixed">微信消息</div>
          <span class="pl-edge">→</span>
          <div class="pl-node pl-fixed">Channel Host</div>
          <span class="pl-edge">→</span>
          <div class="pl-node pl-fixed">消息入库</div>
        </div>

        <div class="pl-flow">
          <div
            class="pl-node pl-triage"
            :class="{ active: triageActive, dim: !triageActive, editing: openNode === 'triage' }"
            @click="toggleNode('triage')"
            role="button"
            tabindex="0"
          >
            <strong>预判分流</strong>
            <small>{{ triageActive ? "运行中" : "已关闭（直通主流程）" }}</small>
            <em>{{ triageActive && pipeline.triage.llmClassifyEnabled ? "规则 + LLM 判定" : "仅兜底" }}</em>
          </div>

          <div class="pl-branches">
            <div
              class="pl-branch pl-human"
              :class="{ editing: openNode === 'human' }"
              @click="toggleNode('human')"
              role="button"
              tabindex="0"
            >
              <b>人工路径</b>
              <span>高危关键词 / LLM 建议人工 → 待认领队列 + 交接摘要</span>
            </div>
            <div
              class="pl-branch"
              :class="directEnabled ? 'pl-fast on' : 'pl-fast off'"
              @click="toggleNode('fast')"
              role="button"
              tabindex="0"
            >
              <b>速答直答 {{ directEnabled ? "· 启用" : "· 关闭" }}</b>
              <span>{{ directEnabled ? "简单题由轻量模型直接回复" : "简单题仍由主力模型回复" }}</span>
            </div>
            <div
              class="pl-branch pl-standard"
              :class="{ editing: openNode === 'standard' }"
              @click="toggleNode('standard')"
              role="button"
              tabindex="0"
            >
              <b>主力决策</b>
              <span>{{ modelNames.text ?? "deepseek 主力" }} · 知识库 / 工具可用</span>
            </div>
          </div>
        </div>

        <div class="pl-row pl-tail">
          <div class="pl-node pl-fixed" :class="{ editing: openNode === 'gate' }" @click="toggleNode('gate')" role="button" tabindex="0">发送闸门</div>
          <span class="pl-edge">→</span>
          <div class="pl-node pl-fixed">微信回复</div>
        </div>

        <footer class="pl-hintbar">
          <span v-if="openNode">提示：修改后点击抽屉底部「保存」</span>
          <span v-else>点击任意节点查看/编辑配置</span>
          <button class="pl-savebtn" :disabled="saving" @click="save">
            {{ saving ? "保存中…" : "保存全部" }}
          </button>
        </footer>
        <p v-if="notice" class="pl-ok">{{ notice }}</p>
        <p v-if="error" class="pl-err">{{ error }}</p>
      </section>

      <!-- 配置抽屉 -->
      <aside v-if="openNode" class="wf-panel pl-drawer">
        <template v-if="openNode === 'triage'">
          <h2>预判分流</h2>
          <label class="pl-field">
            <input v-model="pipeline.triage.enabled" type="checkbox" />
            启用预判分流（关闭时所有消息直接进入主力决策）
          </label>
          <label class="pl-field">
            <input v-model="pipeline.triage.llmClassifyEnabled" type="checkbox" />
            使用极速 LLM 分类（关闭后仅按风险关键词拦截）
          </label>
          <label class="pl-field">
            <input v-model="pipeline.triage.timeoutMs" type="number" min="500" max="15000" step="100" />
            LLM 判定超时（毫秒）
          </label>
          <label class="pl-field">
            高危关键词（逗号分隔，命中即转人工）
            <textarea
              v-model="keywordsText"
              rows="3"
              placeholder="退款，投诉，报警…"
            />
          </label>
        </template>

        <template v-else-if="openNode === 'fast'">
          <h2>速答直答</h2>
          <p class="pl-note">
            直答模型走与主力完全相同的四道发送闸门（接管抑制、重复回复、Kill
            Switch、消息校验）。当前直答档位：
            <code>{{ modelNames.fast ?? "未配置" }}</code>
          </p>
          <label class="pl-field" :class="{ disabled: !triageActive }">
            <input
              v-model="pipeline.triage.allowDirectReply"
              type="checkbox"
              :disabled="!triageActive"
            />
            simple 档启用直答（关闭 = 全部交给主力模型）
          </label>
        </template>

        <template v-else-if="openNode === 'human' || openNode === 'gate'">
          <h2>{{ openNode === 'human' ? '人工路径' : '发送闸门' }}</h2>
          <p class="pl-note">本环节为固定安全设计，暂不开放编辑。</p>
          <ul class="pl-list">
            <li>人工路径：handoff 幂等入队，附 Agent 交接原因；待客服认领。</li>
            <li>发送闸门：人工接管抑制 → 重复回复拦截 → Kill Switch → 回复格式校验。</li>
          </ul>
        </template>

        <template v-else-if="openNode === 'standard'">
          <h2>主力决策</h2>
          <p class="pl-note">
            当前主力档：<code>{{ modelNames.text ?? "-" }}</code
            >；分流档：<code>{{ modelNames.triage ?? "-" }}</code
            >。如需更换模型请前往「系统设置 → 模型管理」。
          </p>
        </template>

        <button class="pl-savebtn full" :disabled="saving" @click="save">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </aside>
    </template>
  </div>
</template>

<style scoped>
.pl-page { padding: 20px 24px; max-width: 1100px; }
.pl-header h1 { font-size: 20px; margin: 0; }
.pl-sub { color: #6b7280; font-size: 13px; margin: 6px 0 18px; }
.pl-loading { color: #6b7280; padding: 40px; }

.pl-graph-panel { position: relative; display: flex; flex-direction: column; gap: 18px; padding: 22px; }
.pl-wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }

.pl-row { display: flex; align-items: center; gap: 10px; }
.pl-tail { justify-content: flex-end; }
.pl-edge { color: #9aa5b1; font-size: 18px; font-weight: 600; }

.pl-node {
  border: 1.5px solid #d6dbe3; border-radius: 12px; background: #fff;
  padding: 10px 16px; font-size: 13px; cursor: pointer; user-select: none;
  transition: box-shadow .15s, border-color .15s;
}
.pl-node:hover { border-color: #2563eb; box-shadow: 0 2px 10px rgba(37,99,235,.15); }
.pl-node.editing { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.pl-node strong { display: block; font-size: 14px; }
.pl-node small, .pl-node em { display: block; color: #6b7280; font-style: normal; margin-top: 3px; }

.pl-triage { min-width: 190px; border-width: 2px; }
.pl-triage.active { border-color: #16a34a; background: #f0fdf4; }
.pl-triage.dim { opacity: .55; border-style: dashed; }

.pl-flow { display: flex; align-items: stretch; gap: 14px; }
.pl-branches { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.pl-branch {
  border: 1.5px solid #e2e6ec; border-radius: 12px; background: #fafbfd;
  padding: 9px 14px; font-size: 13px; cursor: pointer;
}
.pl-branch b { display: block; margin-bottom: 2px; }
.pl-branch span { color: #6b7280; font-size: 12px; }
.pl-branch:hover { border-color: #2563eb; }
.pl-branch.editing { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
.pl-fast.off { opacity: .55; border-style: dashed; }
.pl-fast.on { border-color: #d97706; background: #fffbeb; }
.pl-human { border-left: 4px solid #ef4444; }
.pl-standard { border-left: 4px solid #2563eb; }

.pl-hintbar { display: flex; align-items: center; justify-content: space-between; color: #6b7280; font-size: 13px; border-top: 1px solid #eceff3; padding-top: 12px; }
.pl-savebtn { border: none; background: #2563eb; color: #fff; border-radius: 8px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
.pl-savebtn.full { width: 100%; margin-top: 14px; }
.pl-savebtn:disabled { opacity: .55; cursor: default; }
.pl-ok { color: #15803d; font-size: 13px; margin: 6px 0 0; }
.pl-err { color: #dc2626; font-size: 13px; margin: 6px 0 0; }

.pl-drawer { margin-top: 16px; padding: 18px 20px; }
.pl-drawer h2 { font-size: 15px; margin: 0 0 12px; }
.pl-field { display: block; font-size: 13px; margin-bottom: 12px; }
.pl-field input[type="checkbox"] { margin-right: 8px; }
.pl-field textarea { width: 100%; margin-top: 6px; border: 1px solid #d6dbe3; border-radius: 8px; padding: 8px; font: inherit; resize: vertical; }
.pl-field.disabled { opacity: .5; }
.pl-note { font-size: 13px; color: #6b7280; line-height: 1.7; }
.pl-note code { background: #f1f5f9; border-radius: 4px; padding: 1px 6px; }
.pl-list { font-size: 13px; color: #4b5563; line-height: 1.9; padding-left: 18px; }
</style>
