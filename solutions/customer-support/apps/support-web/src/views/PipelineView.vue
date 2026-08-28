<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import {
  getWorkspaceAgentDefault,
  listAiEmployees,
  setWorkspaceAgentDefault,
  type AiEmployee,
} from "../api/ai-employees";
import { useRouter } from "vue-router";

/**
 * 接待编排页（业务 UI，经 Console ExtensionHost 挂载于 /support/pipeline）。
 *
 * 工作区唯一一张固定拓扑接待图：入库 → 预判分流 → 人工/速答/主力接待 →
 * 发送闸门 → 通道回复。节点不可增删、连线不可重拉。
 *
 * 文案分两类：
 * - 固定说明（硬说明）：解释节点行为的系统级事实，写死在模板里，不可编辑。
 * - 可配置项：只有真正驱动运行时的字段（开关 / 关键词 / 默认员工 / 路由）。
 *
 * 存储走 Core 通用扩展设置（extensionId 固定 support-pipeline），形状：
 * { pipeline: { triage, defaultEmployeeKey, employeeRoutes } }。
 * triage 路径与 Core extractTriagePolicy 兼容；运行时任何路由失败 fail-open。
 * 选择默认员工时同步写 workspace default（运行时权威），避免两份默认源。
 */

type TriageConfig = {
  enabled: boolean;
  riskKeywords: string[];
  llmClassifyEnabled: boolean;
  timeoutMs: number;
  allowDirectReply: boolean;
};

type EmployeeRoute = {
  id: string;
  keywords: string[];
  employeeKey: string;
};

type PipelinePlan = {
  triage: TriageConfig;
  defaultEmployeeKey: string | null;
  employeeRoutes: EmployeeRoute[];
};

const DEFAULT_TRIAGE: TriageConfig = {
  enabled: false,
  riskKeywords: [],
  llmClassifyEnabled: true,
  timeoutMs: 3000,
  allowDirectReply: false,
};

const SETTINGS_URL =
  "/api/v1/admin/solutions/weflow.customer-support/extensions/support-pipeline/settings";

type PlanNode =
  | "triage"
  | "human"
  | "fast"
  | "standard"
  | "gate";

const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");

const plan = ref<PipelinePlan>(cloneDefaults());
/** 扩展设置的完整 JSON（保存时只替换 pipeline 键，其余保留） */
const rawSettings = ref<Record<string, unknown>>({});
/** 平台级模型档位名（只读展示） */
const modelNames = ref<{ text?: string; triage?: string; fast?: string }>({});

const employees = ref<AiEmployee[]>([]);
const workspaceDefaultId = ref<string | null>(null);
const openNode = ref<PlanNode | null>(null);
const keywordsText = ref("");

const router = useRouter();

function cloneDefaults(): PipelinePlan {
  return {
    triage: { ...DEFAULT_TRIAGE, riskKeywords: [] },
    defaultEmployeeKey: null,
    employeeRoutes: [],
  };
}

const activeEmployees = computed(() =>
  employees.value.filter((employee) => employee.status === "active"),
);
const employeeByKey = computed(
  () => new Map(activeEmployees.value.map((item) => [item.key, item])),
);
const employeeById = computed(
  () => new Map(employees.value.map((item) => [item.definitionId, item])),
);

/** 图上默认员工下拉值：优先 plan 里存的 key，否则跟随 workspace default */
const defaultSelectValue = computed<string>(() => {
  if (plan.value.defaultEmployeeKey) return plan.value.defaultEmployeeKey;
  const resolved = workspaceDefaultId.value
    ? employeeById.value.get(workspaceDefaultId.value)
    : undefined;
  return resolved && resolved.status === "active" ? resolved.key : "";
});
const defaultEmployeeName = computed(() => {
  const key = defaultSelectValue.value;
  return key ? (employeeByKey.value.get(key)?.name ?? key) : "";
});
const triageActive = computed(() => plan.value.triage.enabled);
const directEnabled = computed(
  () => triageActive.value && plan.value.triage.allowDirectReply,
);

async function loadAll() {
  loading.value = true;
  error.value = "";
  try {
    const [settings, models, employeeResult, workspaceDefault] =
      await Promise.all([
        api<{ settings: unknown }>(SETTINGS_URL),
        api<{
          settings: {
            textModel: { name: string };
            triageModel?: { name: string };
            fastModel?: { name: string };
          };
        }>("/api/v1/admin/model-settings").catch(() => undefined),
        listAiEmployees().catch(() => undefined),
        getWorkspaceAgentDefault().catch(() => undefined),
      ]);
    rawSettings.value =
      typeof settings.settings === "object" && settings.settings !== null
        ? { ...(settings.settings as Record<string, unknown>) }
        : {};
    applyPipeline(rawSettings.value.pipeline);
    if (models) {
      modelNames.value = {
        text: models.settings.textModel?.name,
        triage: models.settings.triageModel?.name,
        fast: models.settings.fastModel?.name,
      };
    }
    if (employeeResult) employees.value = employeeResult.employees;
    if (workspaceDefault)
      workspaceDefaultId.value = workspaceDefault.setting.defaultDefinitionId;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

/** 从扩展设置的 pipeline 字段容错恢复编排状态（缺省回落默认值） */
function applyPipeline(raw: unknown) {
  const defaults = cloneDefaults();
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const triage =
    typeof source.triage === "object" && source.triage !== null
      ? (source.triage as Record<string, unknown>)
      : {};
  const routes = Array.isArray(source.employeeRoutes)
    ? source.employeeRoutes
    : [];
  plan.value = {
    triage: {
      enabled: typeof triage.enabled === "boolean" ? triage.enabled : defaults.triage.enabled,
      riskKeywords: Array.isArray(triage.riskKeywords)
        ? triage.riskKeywords.filter(
            (word): word is string => typeof word === "string" && word.trim() !== "",
          )
        : [],
      llmClassifyEnabled:
        typeof triage.llmClassifyEnabled === "boolean"
          ? triage.llmClassifyEnabled
          : defaults.triage.llmClassifyEnabled,
      timeoutMs:
        typeof triage.timeoutMs === "number" &&
        Number.isFinite(triage.timeoutMs) &&
        triage.timeoutMs >= 500 &&
        triage.timeoutMs <= 15000
          ? Math.round(triage.timeoutMs)
          : defaults.triage.timeoutMs,
      allowDirectReply:
        typeof triage.allowDirectReply === "boolean"
          ? triage.allowDirectReply
          : defaults.triage.allowDirectReply,
    },
    defaultEmployeeKey:
      typeof source.defaultEmployeeKey === "string" &&
      source.defaultEmployeeKey.trim() !== ""
        ? source.defaultEmployeeKey
        : null,
    employeeRoutes: routes.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const route = item as Record<string, unknown>;
      const keywords = Array.isArray(route.keywords)
        ? route.keywords.filter(
            (word): word is string => typeof word === "string" && word.trim() !== "",
          )
        : [];
      const employeeKey =
        typeof route.employeeKey === "string" ? route.employeeKey : "";
      if (keywords.length === 0 || employeeKey === "") return [];
      return [
        {
          id: typeof route.id === "string" ? route.id : `route-${crypto.randomUUID()}`,
          keywords,
          employeeKey,
        },
      ];
    }),
  };
  keywordsText.value = plan.value.triage.riskKeywords.join("，");
}

function toggleNode(node: PlanNode) {
  openNode.value = openNode.value === node ? null : node;
}

function addRoute() {
  plan.value.employeeRoutes.push({
    id: `route-${crypto.randomUUID()}`,
    keywords: [],
    employeeKey: "",
  });
}

function removeRoute(id: string) {
  plan.value.employeeRoutes = plan.value.employeeRoutes.filter(
    (route) => route.id !== id,
  );
}

/** 保存编排：写扩展设置 + 同步 workspace default（图为主操作面） */
async function save() {
  if (saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    plan.value.triage.riskKeywords = keywordsText.value
      .split(/[，,]/)
      .map((word) => word.trim())
      .filter(Boolean);
    const employeeRoutes = plan.value.employeeRoutes.flatMap((route) => {
      const keywords = route.keywords.filter((word) => word.trim() !== "");
      if (keywords.length === 0 || route.employeeKey === "") return [];
      return [{ id: route.id, keywords, employeeKey: route.employeeKey }];
    });
    await api(SETTINGS_URL, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          ...rawSettings.value,
          pipeline: {
            triage: plan.value.triage,
            defaultEmployeeKey: plan.value.defaultEmployeeKey,
            employeeRoutes,
          },
        },
      }),
    });
    // 同步 workspace default：选中员工 → 其 definitionId；清空 → null。
    const selectedKey = plan.value.defaultEmployeeKey;
    const definitionId = selectedKey
      ? (employeeByKey.value.get(selectedKey)?.definitionId ?? null)
      : null;
    const currentId = workspaceDefaultId.value;
    if (definitionId !== currentId) {
      await setWorkspaceAgentDefault(definitionId);
      workspaceDefaultId.value = definitionId;
    }
    notice.value = "已保存；30 秒内生效（无需重启）";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

function manageEmployees() {
  void router.push({ path: "/support/ai-employees", query: { from: "reception" } });
}

onMounted(loadAll);
</script>

<template>
  <div class="pl-page">
    <header class="pl-header">
      <h1>接待编排</h1>
      <p class="pl-sub">
        一条消息进入后的固定接待路径 · 点击节点配置分流规则与接待员工 ·
        任何判定异常自动回落默认员工
      </p>
    </header>

    <div v-if="loading" class="pl-loading">加载中…</div>

    <template v-else>
      <div v-if="error" class="pl-err pl-top-err" role="alert">
        <span>{{ error }}</span>
        <button class="pl-linkbtn" @click="loadAll">重新加载</button>
      </div>

      <div class="pl-layout">
        <!-- 固定拓扑图 -->
        <section class="wf-panel pl-graph">
          <div class="pl-row">
            <div class="pl-node pl-fixed">微信消息</div>
            <span class="pl-edge">→</span>
            <div class="pl-node pl-fixed">消息入库</div>
            <span class="pl-edge">→</span>
            <div
              class="pl-node"
              :class="{ active: triageActive, dim: !triageActive, editing: openNode === 'triage' }"
              role="button"
              tabindex="0"
              @click="toggleNode('triage')"
              @keydown.enter="toggleNode('triage')"
            >
              <strong>预判分流</strong>
              <small>{{
                triageActive
                  ? plan.triage.llmClassifyEnabled
                    ? "规则 + LLM 判定"
                    : "仅关键词拦截"
                  : "已关闭（直通主力接待）"
              }}</small>
              <em>高危关键词直接转人工；判定异常自动放行主力</em>
            </div>
          </div>

          <div class="pl-flow">
            <div class="pl-branches">
              <div
                class="pl-branch pl-human"
                :class="{ editing: openNode === 'human' }"
                role="button"
                tabindex="0"
                @click="toggleNode('human')"
                @keydown.enter="toggleNode('human')"
              >
                <b>人工路径</b>
                <span>高危命中 → 待认领队列 + 交接摘要</span>
              </div>
              <div
                class="pl-branch"
                :class="directEnabled ? 'pl-fast on' : 'pl-fast off'"
                role="button"
                tabindex="0"
                @click="toggleNode('fast')"
                @keydown.enter="toggleNode('fast')"
              >
                <b>速答直答 {{ directEnabled ? "· 启用" : "· 关闭" }}</b>
                <span>{{
                  directEnabled
                    ? "简单题由轻量模型直接回复"
                    : "简单题仍由主力模型回复"
                }}</span>
              </div>
              <div
                class="pl-branch pl-standard"
                :class="{ editing: openNode === 'standard' }"
                role="button"
                tabindex="0"
                @click="toggleNode('standard')"
                @keydown.enter="toggleNode('standard')"
              >
                <b>主力接待</b>
                <span>{{
                  defaultEmployeeName
                    ? `默认员工：${defaultEmployeeName}`
                    : "未设置默认员工（内置客服提示词）"
                }}</span>
                <em v-if="plan.employeeRoutes.length">
                  {{ plan.employeeRoutes.length }} 条关键词路由
                </em>
              </div>
            </div>
          </div>

          <div class="pl-row pl-tail">
            <div
              class="pl-node"
              :class="{ editing: openNode === 'gate' }"
              role="button"
              tabindex="0"
              @click="toggleNode('gate')"
              @keydown.enter="toggleNode('gate')"
            >
              <strong>发送闸门</strong>
              <small>接管抑制 · 重复拦截 · Kill Switch · 格式校验</small>
            </div>
            <span class="pl-edge">→</span>
            <div class="pl-node pl-fixed">微信回复</div>
          </div>

          <footer class="pl-hintbar">
            <span>{{ openNode ? "修改后在右侧保存" : "点击任意节点查看/编辑配置" }}</span>
            <button class="pl-savebtn" :disabled="saving" @click="save">
              {{ saving ? "保存中…" : "保存全部" }}
            </button>
          </footer>
          <p v-if="notice" class="pl-ok">{{ notice }}</p>
        </section>

        <!-- 节点 Inspector -->
        <aside class="wf-panel pl-inspector">
          <template v-if="openNode === 'triage'">
            <h2>预判分流</h2>
            <div class="pl-hard">
              <b>固定说明</b>
              <p>
                规则先行：命中高危关键词直接转人工（0 成本 0 延迟）；LLM
                分类失败或超时一律放行回主力，绝不因分流层故障阻断消息。
              </p>
            </div>
            <label class="pl-field">
              <input v-model="plan.triage.enabled" type="checkbox" />
              启用预判分流（关闭时所有消息直接进入主力接待）
            </label>
            <label class="pl-field">
              <input v-model="plan.triage.llmClassifyEnabled" type="checkbox" />
              使用极速 LLM 分类（关闭后仅按风险关键词拦截）
            </label>
            <label class="pl-field">
              <input v-model.number="plan.triage.timeoutMs" type="number" min="500" max="15000" step="100" />
              LLM 判定超时（毫秒）
            </label>
            <label class="pl-field">
              高危关键词（逗号分隔，命中即转人工）
              <textarea v-model="keywordsText" rows="3" placeholder="退款，投诉，报警…" />
            </label>
          </template>

          <template v-else-if="openNode === 'human'">
            <h2>人工路径</h2>
            <div class="pl-hard">
              <b>固定说明</b>
              <p>
                固定安全设计，不可配置：handoff 幂等入队，附 Agent
                交接原因，待客服认领。转人工确认话术由程序控制，不在此处修改。
              </p>
            </div>
          </template>

          <template v-else-if="openNode === 'fast'">
            <h2>速答直答</h2>
            <div class="pl-hard">
              <b>固定说明</b>
              <p>
                直答走与主力完全相同的发送闸门，仅替换模型档位；当前直答档位：<code>{{
                  modelNames.fast ?? "未配置"
                }}</code>
              </p>
            </div>
            <label class="pl-field" :class="{ disabled: !triageActive }">
              <input
                v-model="plan.triage.allowDirectReply"
                type="checkbox"
                :disabled="!triageActive"
              />
              simple 档启用直答（关闭 = 全部交给主力模型）
            </label>
          </template>

          <template v-else-if="openNode === 'standard'">
            <h2>主力接待</h2>
            <div class="pl-hard">
              <b>固定说明</b>
              <p>
                决定「交给谁」。优先级：联系人显式绑定 → 关键词路由 →
                默认员工 → 内置提示词；路由未命中或员工已归档时自动回落默认员工。主力档：<code>{{
                  modelNames.text ?? "-"
                }}</code>
              </p>
            </div>
            <label class="pl-field">
              默认 AI 员工（保存时同步为工作区默认）
              <select v-model="plan.defaultEmployeeKey" class="pl-select">
                <option :value="null">未设置（使用内置客服提示词）</option>
                <option
                  v-for="employee in activeEmployees"
                  :key="employee.definitionId"
                  :value="employee.key"
                >
                  {{ employee.name }}（{{ employee.key }}）
                </option>
              </select>
            </label>
            <p v-if="!activeEmployees.length" class="pl-note">
              还没有 AI 员工，先去建立并发布一个。
            </p>

            <div class="pl-routes-head">
              <span>关键词路由（自上而下，第一条命中生效）</span>
              <button class="pl-linkbtn" @click="addRoute">+ 添加路由</button>
            </div>
            <p v-if="!plan.employeeRoutes.length" class="pl-note">
              例：消息含「退货」→ 售后顾问。未命中时走默认员工。
            </p>
            <template v-for="route in plan.employeeRoutes" :key="route.id">
              <div class="pl-route-row">
                <input
                  class="pl-input"
                  placeholder="关键词，逗号分隔"
                  :value="route.keywords.join('，')"
                  @input="route.keywords = (($event.target as HTMLInputElement).value ?? '').split(/[，,]/).map((w) => w.trim()).filter(Boolean)"
                />
                <select v-model="route.employeeKey" class="pl-select">
                  <option value="">选择员工…</option>
                  <option
                    v-for="employee in activeEmployees"
                    :key="employee.definitionId"
                    :value="employee.key"
                  >
                    {{ employee.name }}
                  </option>
                </select>
                <button class="pl-linkbtn danger" @click="removeRoute(route.id)">删除</button>
              </div>
              <p
                v-if="route.employeeKey && !employeeByKey.get(route.employeeKey)"
                class="pl-err pl-route-warn"
              >
                员工 {{ route.employeeKey }} 不存在或已归档，运行时将跳过此路由
              </p>
            </template>

            <button class="pl-savebtn full" @click="manageEmployees">
              管理 AI 员工（Prompt / 版本 / 联系人绑定）
            </button>
          </template>

          <template v-else-if="openNode === 'gate'">
            <h2>发送闸门</h2>
            <div class="pl-hard">
              <b>固定说明</b>
              <p>固定安全设计，不可关闭：所有自动回复（含直答）都经过。</p>
            </div>
            <ul class="pl-list">
              <li>人工接管抑制：会话已转人工则不再自动回复</li>
              <li>重复回复拦截：不逐字重复上一条回复</li>
              <li>Kill Switch：全局停止自动应答</li>
              <li>回复格式校验：分段、长度、声明动作</li>
            </ul>
          </template>

          <template v-else>
            <h2>接待编排总览</h2>
            <div class="pl-hard">
              <b>固定说明</b>
              <p>
                节点不可增删、连线不可更改。可配置项只有各节点内的开关、关键词、默认员工与关键词路由；员工之间的差别是各自已发布的
                Prompt。
              </p>
            </div>
            <ul class="pl-list">
              <li>主力档：<code>{{ modelNames.text ?? "-" }}</code></li>
              <li>分流档：<code>{{ modelNames.triage ?? "-" }}</code></li>
              <li>直答档：<code>{{ modelNames.fast ?? "未配置" }}</code></li>
              <li>默认员工：{{ defaultEmployeeName || "未设置" }}</li>
              <li>
                已启用员工：
                <code v-if="activeEmployees.length">
                  {{ activeEmployees.map((e) => e.name).join("、") }}
                </code>
                <code v-else>暂无</code>
              </li>
            </ul>
            <button class="pl-savebtn full" :disabled="saving" @click="save">
              {{ saving ? "保存中…" : "保存全部" }}
            </button>
          </template>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pl-page { padding: 20px 24px; max-width: 1200px; }
.pl-header h1 { font-size: 20px; margin: 0; }
.pl-sub { color: var(--wf-text-secondary, #6b7280); font-size: 13px; margin: 6px 0 18px; }
.pl-loading { color: var(--wf-text-secondary, #6b7280); padding: 40px; }

.pl-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(300px, 1fr);
  gap: 16px;
  align-items: start;
}

.pl-graph { display: flex; flex-direction: column; gap: 18px; padding: 22px; }
.pl-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pl-tail { justify-content: flex-end; }
.pl-edge { color: var(--wf-text-muted, #9aa5b1); font-size: 18px; font-weight: 600; }

.pl-node {
  border: 1.5px solid var(--wf-border-strong, #d6dbe3);
  border-radius: 12px;
  background: var(--wf-surface, #fff);
  padding: 10px 16px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 0.15s, border-color 0.15s;
}
.pl-node.pl-fixed { cursor: default; }
.pl-node:hover { border-color: var(--wf-primary, #2563eb); box-shadow: 0 2px 10px var(--wf-primary-soft, rgba(37, 99, 235, 0.15)); }
.pl-node.editing { border-color: var(--wf-primary, #2563eb); box-shadow: 0 0 0 3px var(--wf-primary-soft, rgba(37, 99, 235, 0.15)); }
.pl-node strong { display: block; font-size: 14px; }
.pl-node small, .pl-node em {
  display: block;
  color: var(--wf-text-secondary, #6b7280);
  font-style: normal;
  margin-top: 3px;
  max-width: 260px;
}

.pl-node.active { border-color: var(--wf-primary, #16a34a); background: var(--wf-primary-soft, #f0fdf4); }
.pl-node.dim { opacity: 0.55; border-style: dashed; }

.pl-flow { display: flex; align-items: stretch; gap: 14px; }
.pl-branches { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.pl-branch {
  border: 1.5px solid var(--wf-border, #e2e6ec);
  border-radius: 12px;
  background: var(--wf-surface-soft, #fafbfd);
  padding: 9px 14px;
  font-size: 13px;
  cursor: pointer;
}
.pl-branch b { display: block; margin-bottom: 2px; }
.pl-branch span { color: var(--wf-text-secondary, #6b7280); font-size: 12px; }
.pl-branch em { display: block; color: var(--wf-text-muted, #9aa5b1); font-size: 12px; font-style: normal; margin-top: 2px; }
.pl-branch:hover { border-color: var(--wf-primary, #2563eb); }
.pl-branch.editing { border-color: var(--wf-primary, #2563eb); box-shadow: 0 0 0 3px var(--wf-primary-soft, rgba(37, 99, 235, 0.15)); }
.pl-fast.off { opacity: 0.55; border-style: dashed; }
.pl-fast.on { border-color: var(--wf-warning, #d97706); background: rgba(217, 119, 6, 0.06); }
.pl-human { border-left: 4px solid var(--wf-danger, #ef4444); }
.pl-standard { border-left: 4px solid var(--wf-primary, #2563eb); }

.pl-hintbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--wf-text-secondary, #6b7280);
  font-size: 13px;
  border-top: 1px solid var(--wf-border, #eceff3);
  padding-top: 12px;
}
.pl-savebtn {
  border: none;
  background: var(--wf-primary, #2563eb);
  color: var(--wf-on-primary, #fff);
  border-radius: 8px;
  padding: 7px 16px;
  font-size: 13px;
  cursor: pointer;
}
.pl-savebtn.full { width: 100%; margin-top: 14px; }
.pl-savebtn:disabled { opacity: 0.55; cursor: default; }
.pl-ok { color: var(--wf-primary, #15803d); font-size: 13px; margin: 6px 0 0; }
.pl-err { color: var(--wf-danger, #dc2626); font-size: 13px; margin: 6px 0 0; }
.pl-top-err { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.pl-linkbtn {
  border: none;
  background: transparent;
  color: var(--wf-primary, #2563eb);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
}
.pl-linkbtn.danger { color: var(--wf-danger, #dc2626); }

.pl-inspector { padding: 18px 20px; position: sticky; top: 16px; }
.pl-inspector h2 { font-size: 15px; margin: 0 0 12px; }
.pl-hard {
  border-left: 3px solid var(--wf-border-strong, #d6dbe3);
  background: var(--wf-surface-soft, #fafbfd);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
.pl-hard b {
  display: block;
  font-size: 12px;
  color: var(--wf-text-muted, #969c98);
  letter-spacing: 0.02em;
  margin-bottom: 2px;
}
.pl-hard p { margin: 0; font-size: 12.5px; color: var(--wf-text-secondary, #6b7280); line-height: 1.7; }
.pl-hard code { background: var(--wf-surface-inset, #f1f5f9); border-radius: 4px; padding: 1px 6px; }
.pl-field { display: block; font-size: 13px; margin-bottom: 12px; }
.pl-field input[type="checkbox"] { margin-right: 8px; }
.pl-field textarea, .pl-input, .pl-select {
  width: 100%;
  margin-top: 6px;
  border: 1px solid var(--wf-border-strong, #d6dbe3);
  border-radius: 8px;
  padding: 8px;
  font: inherit;
  font-size: 13px;
  background: var(--wf-surface, #fff);
  color: var(--wf-text, #17181a);
  resize: vertical;
}
.pl-select { margin-top: 0; }
.pl-route-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}
.pl-route-row .pl-input, .pl-route-row .pl-select { margin-top: 0; }
.pl-route-warn { margin: 0 0 8px; font-size: 12px; }
.pl-routes-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--wf-text-secondary, #6b7280);
  margin: 12px 0 8px;
}
.pl-field.disabled { opacity: 0.5; }
.pl-note { font-size: 13px; color: var(--wf-text-secondary, #6b7280); line-height: 1.7; }
.pl-note code { background: var(--wf-surface-inset, #f1f5f9); border-radius: 4px; padding: 1px 6px; }
.pl-list { font-size: 13px; color: var(--wf-text-secondary, #4b5563); line-height: 1.9; padding-left: 18px; margin: 8px 0; }

@media (max-width: 1100px) {
  .pl-layout { grid-template-columns: 1fr; }
  .pl-inspector { position: static; }
}
</style>
