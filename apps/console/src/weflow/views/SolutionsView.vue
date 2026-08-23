<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api";
import { confirmDialog } from "../components/confirm-dialog";
import WfDrawer from "../components/WfDrawer.vue";
import PageHeader from "../components/PageHeader.vue";
import WfIcon from "../components/WfIcon.vue";
import { statusTone } from "../components/status-tone";
import { healthLabel } from "../labels";
import { useRoute, useRouter } from "vue-router";
import { useEscClose } from "../composables/use-esc-close";
import {
  solutionPayloadDigestBrowser,
  validateSolutionLock,
  validateSolutionManifest,
} from "@weflow/solution-sdk/browser";

type Installation = {
  solutionId: string;
  version: string;
  desiredState: string;
  observedState: string;
  healthState: string;
  createdAt: string;
  updatedAt: string;
};

type Operation = {
  operationId: string;
  solutionId: string;
  type: string;
  state: string;
  idempotencyKey: string;
  planDigest: string | null;
  attempt: number;
  checkpoint: string | null;
  errorCode: string | null;
  actor: string;
  runnerId: string | null;
  createdAt: string;
};

type Detail = {
  installation: Installation;
  recentOperations: Operation[];
};

type SecretSlotStatus = {
  name: string;
  kind: string;
  required: boolean;
  configured: boolean;
  refType?: string;
  refValue?: string;
};

const loading = ref(true);
const error = ref("");
const installations = ref<Installation[]>([]);
const selected = ref<Installation | null>(null);
const detail = ref<Detail | null>(null);
const secrets = ref<SecretSlotStatus[]>([]);
const detailLoading = ref(false);
const route = useRoute();
const router = useRouter();
useEscClose(computed(() => Boolean(selected.value)), () => closeDetail());

const wizardOpen = ref(false);
const wizardStep = ref<"upload" | "confirm" | "running" | "done">("upload");
const wizardFileInput = ref<HTMLInputElement | null>(null);
const wizardFile = ref<File | null>(null);
const wizardSummary = ref<any>(null);
const wizardPayload = ref<{
  manifest: Record<string, any>;
  lock: Record<string, any>;
  signature: Record<string, any>;
} | null>(null);
const wizardWarnings = ref<string[]>([]);
const wizardAnalyzing = ref(false);
const advancedJson = ref(false);
const manifestText = ref("");
const lockText = ref("");
const signatureText = ref("");
const wizardBusy = ref(false);
const wizardError = ref("");
const wizardNotice = ref("");
const operationBusy = ref<string | null>(null);
const notice = ref("");
const importBusy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const trackedOperationId = ref<string | null>(null);
const trackedOperation = ref<Operation | null>(null);
const trackingOpen = ref(false);
let trackingTimer: ReturnType<typeof setInterval> | null = null;

const canActivate = computed(() => {
  const state = selected.value?.observedState;
  return (
    state === "installed" || state === "configured" || state === "degraded"
  );
});
const canDisable = computed(() => {
  const state = selected.value?.observedState;
  return state === "active" || state === "degraded";
});
const canUninstall = computed(() => {
  const state = selected.value?.observedState;
  return Boolean(
    state &&
      state !== "absent" &&
      state !== "removed" &&
      state !== "uninstalling",
  );
});

function samplePayload() {
  manifestText.value = JSON.stringify(
    {
      apiVersion: "weflow.io/v1",
      kind: "Solution",
      metadata: {
        id: "example.assistant",
        name: "Example Assistant Solution",
        version: "1.0.0",
        publisher: "example",
      },
      compatibility: { platform: ">=1.0.0 <2.0.0", pluginSdk: "^1.0.0" },
      dependencies: { capabilities: ["knowledge.retrieval"], solutions: [] },
      artifacts: [
        {
          id: "assistant-strategy",
          type: "plugin",
          ref: "npm:@example/assistant-strategy",
          digest: `sha256:${"a".repeat(64)}`,
        },
        {
          id: "assistant-web",
          type: "app",
          ref: "npm:@example/assistant-web",
          digest: `sha256:${"c".repeat(64)}`,
        },
      ],
      permissions: [
        { id: "read-conversations", resource: "conversations", action: "read" },
      ],
      configuration: {},
      secretSlots: [
        { name: "assistant_api_key", kind: "env", required: true },
      ],
      resources: [{ id: "assistant-schema", type: "schema", ref: "assistant" }],
      executionProfiles: [
        {
          id: "profile-v1",
          strategyRef: "example.assistant/structured-v1",
          maxModelCalls: 2,
          maxToolCalls: 1,
          timeoutSeconds: 60,
          allowedTools: ["query_contact_profile", "retrieve_knowledge"],
          skills: [
            {
              id: "example.assistant/product-docs",
              version: "1.0.0",
            },
          ],
        },
      ],
      applications: [{ id: "assistant-web", type: "web", entry: "/assistant" }],
      healthChecks: [
        {
          id: "assistant-web-health",
          type: "http",
          target: "/healthz",
          timeoutSeconds: 5,
        },
      ],
    },
    null,
    2,
  );
  lockText.value = JSON.stringify(
    {
      apiVersion: "weflow.io/v1",
      kind: "SolutionLock",
      solutionId: "example.assistant",
      solutionVersion: "1.0.0",
      manifestDigest: "sha256:0ca9075c216c9389a38ef6301b342d5ed4d25c95608379edf0974c14f7a83341",
      dependencies: [],
      artifacts: [
        {
          id: "assistant-strategy",
          ref: "artifacts/assistant-strategy.tgz",
          registry: "file",
          digest: "sha256:9baecc651c1f1c6fac0dd93e526f3f90cb22cea75c4282196ef906adaee1f040",
          size: 45,
          platform: "linux",
          architecture: "x64",
        },
        {
          id: "assistant-web",
          ref: "artifacts/assistant-web.tgz",
          registry: "file",
          digest: "sha256:8b30fe3f864d41114659ab4482ec30d76fc45c3e36ba8656ee9cd5cf421a491a",
          size: 31,
          platform: "linux",
          architecture: "x64",
        },
        {
          id: "assistant-schema",
          ref: "artifacts/assistant-schema.sql",
          registry: "file",
          digest: "sha256:687b2c9241bf988aa4122279ffb147a36450a82c52d4dfec802536b9660b67f6",
          size: 37,
        },
      ],
      targetPlatform: "linux",
      targetArchitecture: "x64",
      sbom: "sbom.json",
    },
    null,
    2,
  );
  signatureText.value = JSON.stringify(
    {
      algorithm: "ed25519",
      keyId: "dev-key",
      digest: "sha256:0ca9075c216c9389a38ef6301b342d5ed4d25c95608379edf0974c14f7a83341",
      signature: "sloY2GtvBPjYYkLeIJwYlki72VGcJ2IsnBK2cf3DENAw+5jcmZQSxQsw8KoIDFB7iLW8B7uk4d6p2v9fyl70AQ==",
    },
    null,
    2,
  );
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await api<{ solutions: Installation[] }>(
      "/api/v1/admin/solutions",
    );
    installations.value = data.solutions;
    if (selected.value) {
      const current = data.solutions.find(
        (item) => item.solutionId === selected.value?.solutionId,
      );
      if (current) selected.value = current;
      else {
        closeDetail();
      }
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function selectSolution(installation: Installation) {
  if (selected.value?.solutionId === installation.solutionId) {
    closeDetail();
    return;
  }
  selected.value = installation;
  await router.replace({ query: { ...route.query, solution: installation.solutionId } });
  detailLoading.value = true;
  detail.value = null;
  secrets.value = [];
  try {
    const data = await api<Detail>(
      `/api/v1/admin/solutions/${encodeURIComponent(installation.solutionId)}`,
    );
    detail.value = data;
    const secretData = await api<{ slots: SecretSlotStatus[] }>(
      `/api/v1/admin/solutions/${encodeURIComponent(installation.solutionId)}/secrets`,
    );
    secrets.value = secretData.slots;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载详情失败";
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  selected.value = null;
  detail.value = null;
  secrets.value = [];
  if (route.query.solution) {
    const query = { ...route.query };
    delete query.solution;
    void router.replace({ query });
  }
}

async function install() {
  wizardError.value = "";
  wizardNotice.value = "";
  let manifest: unknown;
  let lock: unknown;
  let signature: unknown;
  try {
    manifest = JSON.parse(manifestText.value);
    lock = JSON.parse(lockText.value);
    signature = JSON.parse(signatureText.value);
  } catch {
    wizardError.value = "Manifest / Lock / Signature 必须是合法 JSON";
    return;
  }
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    wizardError.value = "Manifest 或 Lock 未通过严格校验，请检查后重试";
    return;
  }
  const planDigest = await solutionPayloadDigestBrowser(
    manifestResult.value,
    lockResult.value,
  );
  const body = {
    solutionId: manifestResult.value.metadata.id,
    type: "install",
    idempotencyKey: `console-install-${Date.now()}`,
    solutionVersion: manifestResult.value.metadata.version,
    planDigest,
    manifest,
    lock,
    signature,
  };
  wizardBusy.value = true;
  try {
    await api("/api/v1/admin/solution-operations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    wizardNotice.value = "安装 Operation 已创建，Runner 将自动执行";
    wizardOpen.value = false;
    await load();
  } catch (reason) {
    wizardError.value = reason instanceof Error ? reason.message : "创建失败";
  } finally {
    wizardBusy.value = false;
  }
}

function openWizard() {
  wizardOpen.value = true;
  wizardStep.value = "upload";
  wizardFile.value = null;
  wizardSummary.value = null;
  wizardPayload.value = null;
  wizardWarnings.value = [];
  wizardError.value = "";
  wizardNotice.value = "";
  advancedJson.value = false;
}

async function analyzeWizardFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  wizardFile.value = file;
  wizardAnalyzing.value = true;
  wizardError.value = "";
  wizardNotice.value = "";
  try {
    const form = new FormData();
    form.append("file", file);
    const payload = await api<{
      valid: boolean;
      error?: string;
      summary?: any;
      warnings?: string[];
      payload?: {
        manifest: Record<string, any>;
        lock: Record<string, any>;
        signature: Record<string, any>;
      };
    }>("/api/v1/admin/solution-packages/analyze", {
      method: "POST",
      body: form,
    });
    if (!payload.valid) {
      wizardError.value = payload.error ?? "方案包解析失败";
      return;
    }
    wizardSummary.value = payload.summary;
    wizardPayload.value = payload.payload ?? null;
    wizardWarnings.value = payload.warnings ?? [];
    wizardStep.value = "confirm";
  } catch (reason) {
    wizardError.value = reason instanceof Error ? reason.message : "解析失败";
  } finally {
    wizardAnalyzing.value = false;
    if (input) input.value = "";
  }
}

async function confirmInstall() {
  if (!wizardPayload.value) return;
  wizardError.value = "";
  wizardNotice.value = "";
  const { manifest, lock, signature } = wizardPayload.value;
  const manifestResult = validateSolutionManifest(manifest);
  const lockResult = validateSolutionLock(lock);
  if (!manifestResult.ok || !lockResult.ok) {
    wizardError.value = "Manifest 或 Lock 未通过严格校验，请检查后重试";
    return;
  }
  const planDigest = await solutionPayloadDigestBrowser(
    manifestResult.value,
    lockResult.value,
  );
  const body = {
    solutionId: manifestResult.value.metadata.id,
    type: "install",
    idempotencyKey: `console-install-${Date.now()}`,
    solutionVersion: manifestResult.value.metadata.version,
    planDigest,
    manifest,
    lock,
    signature,
  };
  wizardBusy.value = true;
  try {
    const result = await api<{ operation: Operation }>(
      "/api/v1/admin/solution-operations",
      { method: "POST", body: JSON.stringify(body) },
    );
    wizardNotice.value = "安装 Operation 已创建，Runner 将自动执行";
    startTracking(result.operation.operationId);
    wizardStep.value = "running";
    await load();
  } catch (reason) {
    wizardError.value = reason instanceof Error ? reason.message : "创建失败";
  } finally {
    wizardBusy.value = false;
  }
}

async function pollOperation() {
  if (!trackedOperationId.value) return;
  try {
    const data = await api<{ operation: Operation }>(
      `/api/v1/admin/solution-operations/${encodeURIComponent(trackedOperationId.value)}`,
    );
    trackedOperation.value = data.operation;
    if (["succeeded", "failed", "cancelled"].includes(data.operation.state)) {
      stopTracking();
      if (wizardStep.value === "running") wizardStep.value = "done";
      await load();
    }
  } catch {
    // 瞬态错误：保留轮询，下一次成功时继续
  }
}

function startTracking(operationId: string) {
  stopTracking();
  trackedOperationId.value = operationId;
  trackedOperation.value = null;
  trackingOpen.value = true;
  void pollOperation();
  trackingTimer = setInterval(() => {
    void pollOperation();
  }, 2000);
}

function stopTracking() {
  if (trackingTimer) {
    clearInterval(trackingTimer);
    trackingTimer = null;
  }
}

function closeTracking() {
  stopTracking();
  trackingOpen.value = false;
  if (wizardStep.value === "running" || wizardStep.value === "done") {
    wizardOpen.value = false;
  }
}

async function importZip(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importBusy.value = true;
  notice.value = "";
  try {
    const form = new FormData();
    form.append("file", file);
    const response = await fetch("/api/v1/admin/solutions/import", {
      method: "POST",
      body: form,
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        typeof payload?.error === "string" ? payload.error : "导入失败",
      );
    }
    notice.value = "压缩包已导入，安装 Operation 已创建";
    if (payload?.operation?.operationId) {
      startTracking(payload.operation.operationId);
    }
    await load();
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "导入失败";
  } finally {
    importBusy.value = false;
    input.value = "";
  }
}

async function runOperation(type: "activate" | "disable" | "uninstall") {
  if (!selected.value) return;
  if (type === "disable" || type === "uninstall") {
    const confirmed = await confirmDialog(
      type === "uninstall"
        ? `确认卸载 ${selected.value.solutionId}？\n\n卸载会停止未来运行、移除组合关系并归档方案资源；历史会话和审计数据会保留。该操作会写入审计。`
        : `确认停用 ${selected.value.solutionId}？\n\n停用后该方案将不再运行，可以随时重新激活。该操作会写入审计。`,
      { danger: type === "uninstall" },
    );
    if (!confirmed) return;
  }
  operationBusy.value = type;
  notice.value = "";
  try {
    const result = await api<{ operation: Operation }>(
      "/api/v1/admin/solution-operations",
      {
        method: "POST",
        body: JSON.stringify({
          solutionId: selected.value.solutionId,
          type,
          idempotencyKey: `console-${type}-${Date.now()}`,
        }),
      },
    );
    notice.value = `${type} Operation 已创建，Runner 将自动执行`;
    startTracking(result.operation.operationId);
    await load();
  } catch (reason) {
    notice.value = reason instanceof Error ? reason.message : "创建失败";
  } finally {
    operationBusy.value = null;
  }
}

function stateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const map: Record<string, string> = {
    absent: "未安装",
    installing: "安装中",
    installed: "已安装",
    configured: "已配置",
    activating: "激活中",
    active: "已激活",
    degraded: "降级",
    rolling_back: "回滚中",
    uninstalling: "卸载中",
    removed: "已卸载",
    failed: "失败",
    disabled: "停用",
    unknown: "未知",
  };
  return map[value] ?? value;
}

function operationStateLabel(value: string): string {
  const map: Record<string, string> = {
    queued: "排队中",
    claimed: "已领取",
    running: "执行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[value] ?? value;
}

function operationTypeLabel(value: string): string {
  const map: Record<string, string> = {
    install: "安装",
    configure: "配置",
    activate: "激活",
    disable: "停用",
    upgrade: "升级",
    rollback: "回滚",
    uninstall: "卸载",
  };
  return map[value] ?? value;
}

onBeforeUnmount(stopTracking);
onMounted(async () => {
  await load();
  const solutionId = typeof route.query.solution === "string" ? route.query.solution : "";
  if (solutionId) {
    const found = installations.value.find((item) => item.solutionId === solutionId);
    if (found) await selectSolution(found);
  }
});
</script>

<template>
  <div class="wf-page">
    <PageHeader title="业务方案" />
    <div v-if="error" class="wf-error" role="alert">
      <span>{{ error }}</span>
      <button class="wf-button compact" @click="load">重新加载</button>
    </div>
    <div v-if="notice" class="wf-notice" role="status">{{ notice }}</div>

    <section class="wf-panel">
      <div class="wf-panel-head">
        <h2>已安装方案</h2>
        <div class="wf-actions">
          <button class="wf-button compact" :disabled="loading" @click="load">刷新</button>
          <button class="wf-button compact" :disabled="importBusy" @click="fileInput?.click()">
            {{ importBusy ? "导入中…" : "导入压缩包" }}
          </button>
          <button class="wf-button primary compact" @click="openWizard">安装方案</button>
          <input
            ref="fileInput"
            type="file"
            accept=".zip,application/zip"
            style="display: none"
            @change="importZip"
          />
        </div>
      </div>
      <div class="wf-table-wrap">
        <table class="wf-table" data-card>
          <thead>
            <tr>
              <th>方案</th>
              <th>版本</th>
              <th>期望状态</th>
              <th>实际状态</th>
              <th>健康</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in installations"
              :key="item.solutionId"
              :class="{
                'wf-row-selected': selected?.solutionId === item.solutionId,
              }"
              @click="selectSolution(item)"
            >
              <td data-label="方案">{{ item.solutionId }}</td>
              <td data-label="版本">{{ item.version }}</td>
              <td data-label="期望状态">
                  <i class="wf-health-mark" :class="statusTone(item.desiredState)"></i>
                {{ stateLabel(item.desiredState) }}
              </td>
              <td data-label="实际状态">
                  <i class="wf-health-mark" :class="statusTone(item.observedState)"></i>
                {{ stateLabel(item.observedState) }}
              </td>
              <td data-label="健康">
                  <i class="wf-health-mark" :class="statusTone(item.healthState)"></i>
                {{ healthLabel(item.healthState).text }}
              </td>
              <td data-label="更新时间">{{ new Date(item.updatedAt).toLocaleString() }}</td>
            </tr>
            <tr v-if="!loading && installations.length === 0">
              <td colspan="6" class="wf-empty">还没有安装任何方案</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <WfDrawer :open="Boolean(selected)" title="业务方案详情" @close="closeDetail">
      <div v-if="selected" class="wf-drawer-body">
        <section class="wf-drawer-section">
          <div class="wf-solution-detail-meta">
            <span class="wf-status" :class="statusTone(selected.observedState)">{{ stateLabel(selected.observedState) }}</span>
            <span class="wf-status" :class="statusTone(selected.healthState)">{{ healthLabel(selected.healthState).text }}</span>
          </div>
          <div class="wf-drawer-actions">
            <button class="wf-button compact" :disabled="!canActivate || operationBusy !== null" @click="runOperation('activate')">激活</button>
            <button class="wf-button compact" :disabled="!canDisable || operationBusy !== null" @click="runOperation('disable')">停用</button>
            <button class="wf-button compact danger" :disabled="!canUninstall || operationBusy !== null" @click="runOperation('uninstall')">卸载</button>
          </div>
        </section>
        <section class="wf-drawer-section">
          <h3>最近操作</h3>
          <div v-if="detailLoading" class="wf-muted">加载中…</div>
          <div v-else-if="detail" class="wf-drawer-operation-list">
            <div v-for="operation in detail.recentOperations" :key="operation.operationId" class="wf-drawer-operation-row">
              <div class="wf-drawer-operation-main">
                <strong>{{ operationTypeLabel(operation.type) }}</strong>
                <span class="wf-status" :class="statusTone(operation.state)">{{ operationStateLabel(operation.state) }}</span>
              </div>
              <div class="wf-muted">{{ operation.actor }} · {{ new Date(operation.createdAt).toLocaleString() }}</div>
              <div v-if="operation.errorCode" class="wf-error" role="alert">{{ operation.errorCode }}</div>
            </div>
            <div v-if="detail.recentOperations.length === 0" class="wf-empty">暂无操作记录</div>
          </div>
        </section>
        <section class="wf-drawer-section">
          <h3>Secret 配置状态</h3>
          <div v-if="detailLoading" class="wf-muted">加载中…</div>
          <div v-else class="wf-drawer-secret-list">
            <div v-for="slot in secrets" :key="slot.name" class="wf-drawer-secret-row">
              <span>{{ slot.name }}</span>
              <span class="wf-status" :class="slot.configured ? 'good' : 'warn'">{{ slot.configured ? '已配置' : '缺失' }}</span>
              <span v-if="slot.configured" class="wf-muted">{{ slot.refType }}:{{ slot.refValue }}</span>
            </div>
            <div v-if="secrets.length === 0" class="wf-empty">暂无 Secret Slot 信息</div>
          </div>
        </section>
      </div>
    </WfDrawer>
    <div v-if="wizardOpen" class="wf-modal-mask" @click.self="wizardOpen = false">
      <div class="wf-modal">
        <div class="wf-modal-head">
          <h2>
            {{
              wizardStep === "upload"
                ? "安装方案"
                : wizardStep === "confirm"
                  ? "确认安装"
                  : wizardStep === "running"
                    ? "安装执行中"
                    : "安装完成"
            }}
          </h2>
          <button
            class="wf-icon-button"
            :disabled="wizardStep === 'running'"
            :title="wizardStep === 'running' ? '执行中请稍候' : '关闭'"
            @click="wizardOpen = false"
          >
            <WfIcon name="close" :size="17" />
          </button>
        </div>
        <div class="wf-wizard-steps" aria-label="安装步骤">
          <ol>
            <li
              class="wf-wizard-step"
              :class="{ active: wizardStep === 'upload', done: wizardStep !== 'upload' }"
            >
              <span class="wf-wizard-step-num">1</span>
              <span class="wf-wizard-step-label">选择方案包</span>
            </li>
            <li
              class="wf-wizard-step"
              :class="{
                active: wizardStep === 'confirm',
                done: wizardStep === 'running' || wizardStep === 'done',
              }"
            >
              <span class="wf-wizard-step-num">2</span>
              <span class="wf-wizard-step-label">确认安装</span>
            </li>
            <li
              class="wf-wizard-step"
              :class="{
                active: wizardStep === 'running' || wizardStep === 'done',
                done: wizardStep === 'done',
              }"
            >
              <span class="wf-wizard-step-num">3</span>
              <span class="wf-wizard-step-label">执行</span>
            </li>
          </ol>
        </div>
<div class="wf-modal-body">
          <template v-if="!advancedJson">
            <div v-if="wizardStep === 'upload'" class="wf-field">
              <span>选择方案包</span>
              <input
                ref="wizardFileInput"
                type="file"
                accept=".zip,application/zip"
                class="wf-input"
                :disabled="wizardAnalyzing"
                @change="analyzeWizardFile"
              />
              <p class="wf-hint">
                上传包含 solution.manifest.json / solution.lock.json / signature.json
                的 ZIP 压缩包，系统会自动解析并展示摘要。
              </p>
              <button class="wf-link wf-link-button" @click="advancedJson = true">
                使用 JSON 安装（高级）
              </button>
            </div>

            <div v-else-if="wizardStep === 'confirm' && wizardSummary" class="wf-summary">
              <dl class="wf-summary-grid">
                <div>
                  <dt>方案</dt>
                  <dd>{{ wizardSummary.name }}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd class="wf-mono">{{ wizardSummary.solutionId }}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{{ wizardSummary.version }}</dd>
                </div>
                <div>
                  <dt>发布者</dt>
                  <dd>{{ wizardSummary.publisher }}</dd>
                </div>
                <div v-if="wizardSummary.permissions?.length">
                  <dt>权限</dt>
                  <dd>{{ wizardSummary.permissions.join("、") }}</dd>
                </div>
                <div v-if="wizardSummary.secretSlots?.length">
                  <dt>Secret 槽位</dt>
                  <dd>
                    <span
                      v-for="slot in wizardSummary.secretSlots"
                      :key="slot.name"
                      class="wf-status"
                      :class="slot.required ? 'warn' : 'neutral'"
                    >
                      {{ slot.name }}{{ slot.required ? "（必填）" : "" }}
                    </span>
                  </dd>
                </div>
                <div v-if="wizardSummary.executionProfiles?.length">
                  <dt>执行配置</dt>
                  <dd>{{ wizardSummary.executionProfiles.join("、") }}</dd>
                </div>
              </dl>
              <div v-if="wizardWarnings.length" class="wf-error" role="alert">
                <strong>解析警告</strong>
                <ul>
                  <li v-for="warning in wizardWarnings" :key="warning">
                    {{ warning }}
                  </li>
                </ul>
              </div>
              <div class="wf-actions">
                <button
                  class="wf-button compact"
                  :disabled="wizardBusy"
                  @click="wizardStep = 'upload'"
                >
                  重新选择
                </button>
                <button
                  class="wf-link wf-link-button"
                  :disabled="wizardBusy"
                  @click="advancedJson = true"
                >
                  改用 JSON
                </button>
              </div>
            </div>

            <div v-else-if="wizardStep === 'running' || wizardStep === 'done'">
              <div v-if="trackedOperation" class="wf-operation-progress">
                <div class="wf-operation-state">
                  <strong>状态</strong>
                  <span
                    class="wf-status"
                    :class="statusTone(trackedOperation.state)"
                  >
                    {{ operationStateLabel(trackedOperation.state) }}
                  </span>
                </div>
                <div class="wf-operation-state">
                  <strong>Checkpoint</strong>
                  <span>{{ trackedOperation.checkpoint ?? "—" }}</span>
                </div>
                <div v-if="trackedOperation.errorCode" class="wf-error" role="alert">
                  错误：{{ trackedOperation.errorCode }}
                </div>
                <p v-if="wizardStep === 'running'" class="wf-hint">
                  Runner 正在执行，页面每 2 秒自动刷新进度。
                </p>
                <p v-else class="wf-notice" role="status">安装操作已结束。</p>
              </div>
              <div v-else>
                <span class="wf-skeleton">正在读取执行状态…</span>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="wf-form-row">
              <button class="wf-button compact" @click="samplePayload">
                填入示例
              </button>
              <span class="wf-hint">示例为 Customer Support Solution fixture</span>
            </div>
            <label class="wf-field">
              <span>Manifest JSON</span>
              <textarea v-model="manifestText" rows="8" spellcheck="false"></textarea>
            </label>
            <label class="wf-field">
              <span>Lock JSON</span>
              <textarea v-model="lockText" rows="8" spellcheck="false"></textarea>
            </label>
            <label class="wf-field">
              <span>Signature JSON</span>
              <textarea v-model="signatureText" rows="4" spellcheck="false"></textarea>
            </label>
            <button
              class="wf-link wf-link-button"
              :disabled="wizardBusy"
              @click="advancedJson = false"
            >
              返回上传方式
            </button>
          </template>

          <div v-if="wizardError" class="wf-error" role="alert">{{ wizardError }}</div>
          <div v-if="wizardNotice" class="wf-notice" role="status">{{ wizardNotice }}</div>
        </div>
        <div class="wf-modal-foot">
          <template v-if="advancedJson">
            <button
              class="wf-button"
              :disabled="wizardBusy"
              @click="wizardOpen = false"
            >
              取消
            </button>
            <button
              class="wf-button primary"
              :disabled="wizardBusy"
              @click="install"
            >
              {{ wizardBusy ? "提交中…" : "创建安装 Operation" }}
            </button>
          </template>
          <template v-else-if="wizardStep === 'upload'">
            <button
              class="wf-button"
              :disabled="wizardAnalyzing"
              @click="wizardOpen = false"
            >
              取消
            </button>
          </template>
          <template v-else-if="wizardStep === 'confirm'">
            <button
              class="wf-button"
              :disabled="wizardBusy"
              @click="wizardStep = 'upload'"
            >
              上一步
            </button>
            <button
              class="wf-button primary"
              :disabled="wizardBusy || !wizardPayload"
              @click="confirmInstall"
            >
              {{ wizardBusy ? "提交中…" : "确认并创建安装" }}
            </button>
          </template>
          <template v-else-if="wizardStep === 'running'">
            <button class="wf-button" disabled>执行中…</button>
          </template>
          <template v-else>
            <button class="wf-button primary" @click="wizardOpen = false">
              完成
            </button>
          </template>
        </div>
      </div>
    </div>

    <div
      v-if="trackingOpen && !wizardOpen"
      class="wf-modal-mask"
      @click.self="closeTracking"
    >
      <div class="wf-modal wf-modal-narrow">
        <div class="wf-modal-head">
          <h2>操作执行中</h2>
          <button class="wf-icon-button" @click="closeTracking"><WfIcon name="close" :size="17" /></button>
        </div>
        <div class="wf-modal-body">
          <div v-if="trackedOperation" class="wf-operation-progress">
            <div class="wf-operation-state">
              <strong>状态</strong>
              <span class="wf-status" :class="statusTone(trackedOperation.state)">
                {{ operationStateLabel(trackedOperation.state) }}
              </span>
            </div>
            <div class="wf-operation-state">
              <strong>Checkpoint</strong>
              <span>{{ trackedOperation.checkpoint ?? "—" }}</span>
            </div>
            <div v-if="trackedOperation.errorCode" class="wf-error" role="alert">
              错误：{{ trackedOperation.errorCode }}
            </div>
            <p class="wf-hint">页面每 2 秒自动刷新进度。</p>
          </div>
          <div v-else>
            <span class="wf-skeleton">正在读取执行状态…</span>
          </div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="closeTracking">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.wf-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}
.wf-summary-grid div {
  padding: 10px 12px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface-soft);
}
.wf-summary-grid dt {
  font-size: 12px;
  color: var(--wf-text-muted);
  margin-bottom: 4px;
}
.wf-summary-grid dd {
  margin: 0;
  font-weight: 600;
  word-break: break-all;
}
.wf-summary-grid dd .wf-status {
  margin-right: 6px;
}
.wf-operation-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wf-operation-state {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wf-operation-state strong {
  min-width: 88px;
  color: var(--wf-text-secondary);
  font-size: 13px;
}
.wf-operation-state span {
  font-weight: 600;
}
.wf-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wf-solution-detail-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.wf-drawer-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.wf-drawer-operation-list,
.wf-drawer-secret-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.wf-drawer-operation-row,
.wf-drawer-secret-row {
  padding: 10px 12px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface-soft);
}
.wf-drawer-operation-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wf-drawer-secret-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.wf-drawer-section h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.wf-wizard-steps {
  padding: 14px 16px 0;
  border-bottom: 1px solid var(--wf-border);
}
.wf-wizard-steps ol {
  display: flex;
  align-items: center;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wf-wizard-step {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--wf-text-muted);
  font-size: 12px;
  font-weight: 600;
}
.wf-wizard-step + .wf-wizard-step {
  margin-left: 12px;
}
.wf-wizard-step + .wf-wizard-step::before {
  content: "";
  width: 28px;
  height: 1px;
  margin-right: 12px;
  background: var(--wf-border-strong);
}
.wf-wizard-step-num {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: 1px solid var(--wf-border-strong);
  border-radius: 50%;
  background: var(--wf-surface);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.wf-wizard-step.active {
  color: var(--wf-text);
}
.wf-wizard-step.active .wf-wizard-step-num {
  background: var(--wf-primary);
  border-color: var(--wf-primary);
  color: var(--wf-on-primary);
}
.wf-wizard-step.done {
  color: var(--wf-primary);
}
.wf-wizard-step.done .wf-wizard-step-num {
  border-color: var(--wf-primary);
  color: var(--wf-primary);
  background: var(--wf-primary-soft);
}
</style>
