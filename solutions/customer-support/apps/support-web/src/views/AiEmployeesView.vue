<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  archiveAiEmployee,
  createAiEmployee,
  createAiEmployeeVersion,
  getWorkspaceAgentDefault,
  listAiEmployees,
  listContactAgentBindings,
  listContacts,
  publishAiEmployeeVersion,
  removeContactAgentBinding,
  rollbackAiEmployeeVersion,
  setContactAgentBinding,
  setWorkspaceAgentDefault,
  updateAiEmployee,
  updateAiEmployeeVersion,
  type AiEmployee,
  type AiEmployeeVersion,
  type ContactAgentBinding,
  type ContactSummary,
} from "../api/ai-employees";
import { contactDisplayName } from "../labels";

const route = useRoute();
const router = useRouter();
const employees = ref<AiEmployee[]>([]);
const contacts = ref<ContactSummary[]>([]);
const bindings = ref<ContactAgentBinding[]>([]);
const search = ref("");
const selectedId = ref("");
const selectedVersionId = ref("");
const defaultId = ref<string | null>(null);
const loading = ref(true);
const saving = ref(false);
const savingBindingContactId = ref("");
const bindingError = ref("");
const error = ref("");
const editing = ref(false);
const creating = ref(false);
const prompt = ref("");
const name = ref("");
const description = ref("");
const newKey = ref("");
const newName = ref("");
const newPrompt = ref("");
const newDescription = ref("");

const selected = computed(() =>
  employees.value.find((item) => item.definitionId === selectedId.value),
);
const selectedVersion = computed(() =>
  selected.value?.versions.find(
    (item) => item.versionId === selectedVersionId.value,
  ),
);
const publishedVersion = computed(() =>
  selected.value?.versions.find((item) => item.status === "published"),
);
const bindingMap = computed(
  () => new Map(bindings.value.map((binding) => [binding.contactId, binding])),
);
const activeEmployees = computed(() =>
  employees.value.filter((item) => item.status === "active"),
);
const visibleContacts = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return contacts.value;
  return contacts.value.filter((contact) =>
    [
      contact.contactId,
      contact.channelDisplayName,
      contact.channelNickname,
      contact.channelRemark,
      contact.sharedAlias,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)),
  );
});

function contactLabel(contact: ContactSummary) {
  return contactDisplayName({ contact });
}

function selectEmployee(employee: AiEmployee) {
  selectedId.value = employee.definitionId;
  const routeId = route.params.definitionId;
  const nextVersion =
    typeof routeId === "string" && employee.versions.some((v) => v.versionId === routeId)
      ? routeId
      : employee.versions[0]?.versionId ?? "";
  selectedVersionId.value = nextVersion;
  editing.value = false;
  router.replace({
    name: "aiEmployeePrompt",
    params: { definitionId: employee.definitionId },
  });
}

function beginEdit(version = selectedVersion.value) {
  if (!selected.value || !version) return;
  name.value = selected.value.name;
  description.value = selected.value.description ?? "";
  prompt.value = version.prompt;
  selectedVersionId.value = version.versionId;
  editing.value = true;
}

async function load() {
  loading.value = true;
  error.value = "";
  bindingError.value = "";
  try {
    const [employeeResult, setting, contactResult, bindingResult] =
      await Promise.all([
        listAiEmployees(),
        getWorkspaceAgentDefault(),
        listContacts(),
        listContactAgentBindings(),
      ]);
    employees.value = employeeResult.employees;
    defaultId.value = setting.setting.defaultDefinitionId;
    contacts.value = contactResult.contacts;
    bindings.value = bindingResult.bindings;
    const routeEmployeeId =
      typeof route.params.definitionId === "string" ? route.params.definitionId : "";
    const next = employees.value.find(
      (item) => item.definitionId === routeEmployeeId,
    ) ?? employees.value[0];
    if (next) {
      selectedId.value = next.definitionId;
      selectedVersionId.value =
        next.versions.find((item) => item.status === "draft")?.versionId ??
        next.versions[0]?.versionId ??
        "";
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "AI Employee 加载失败";
  } finally {
    loading.value = false;
  }
}

async function createEmployee() {
  if (!newKey.value || !newName.value || !newPrompt.value) return;
  creating.value = true;
  error.value = "";
  try {
    const result = await createAiEmployee({
      key: newKey.value,
      name: newName.value,
      description: newDescription.value || null,
      prompt: newPrompt.value,
    });
    newKey.value = "";
    newName.value = "";
    newDescription.value = "";
    newPrompt.value = "";
    await load();
    const created = employees.value.find(
      (item) => item.definitionId === result.employee.definition.definitionId,
    );
    if (created) selectEmployee(created);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "AI Employee 创建失败";
  } finally {
    creating.value = false;
  }
}

async function saveDraft() {
  if (!selected.value || !selectedVersion.value || selectedVersion.value.status !== "draft") return;
  saving.value = true;
  error.value = "";
  try {
    await Promise.all([
      updateAiEmployee(selected.value.definitionId, {
        name: name.value,
        description: description.value || null,
      }),
      updateAiEmployeeVersion(selectedVersion.value.versionId, prompt.value),
    ]);
    editing.value = false;
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "草稿保存失败";
  } finally {
    saving.value = false;
  }
}

async function createVersion() {
  if (!selected.value) return;
  saving.value = true;
  try {
    const result = await createAiEmployeeVersion(
      selected.value.definitionId,
      selectedVersion.value?.prompt ?? publishedVersion.value?.prompt ?? "",
    );
    await load();
    selectedVersionId.value = result.version.versionId;
    beginEdit(result.version);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "新版本创建失败";
  } finally {
    saving.value = false;
  }
}

async function publish() {
  if (!selectedVersion.value || selectedVersion.value.status !== "draft") return;
  if (!window.confirm("发布后，新创建的 Agent Turn 将使用此版本。确认发布？")) return;
  saving.value = true;
  try {
    await publishAiEmployeeVersion(selectedVersion.value.versionId);
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "发布失败";
  } finally {
    saving.value = false;
  }
}

async function rollback() {
  if (!selectedVersion.value || selectedVersion.value.status !== "retired") return;
  if (!window.confirm("将这个历史版本恢复为线上版本？")) return;
  saving.value = true;
  try {
    await rollbackAiEmployeeVersion(selectedVersion.value.versionId);
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "回滚失败";
  } finally {
    saving.value = false;
  }
}

async function archive() {
  if (!selected.value || !window.confirm("归档这个 AI Employee？归档后不会再作为默认绑定解析。")) return;
  saving.value = true;
  try {
    await archiveAiEmployee(selected.value.definitionId);
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "归档失败";
  } finally {
    saving.value = false;
  }
}

async function changeDefault() {
  try {
    await setWorkspaceAgentDefault(defaultId.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "默认 AI Employee 设置失败";
  }
}

async function changeBinding(contactId: string, value: string) {
  savingBindingContactId.value = contactId;
  bindingError.value = "";
  try {
    if (value) await setContactAgentBinding(contactId, value);
    else await removeContactAgentBinding(contactId);
    await load();
  } catch (reason) {
    bindingError.value =
      reason instanceof Error ? reason.message : "联系人绑定保存失败";
  } finally {
    savingBindingContactId.value = "";
  }
}

function onBindingChange(contactId: string, event: Event) {
  const target = event.target;
  if (target instanceof HTMLSelectElement)
    void changeBinding(contactId, target.value);
}

function versionLabel(version: AiEmployeeVersion) {
  return `v${version.version}`;
}

onMounted(load);
</script>

<template>
  <div class="wf-page wf-page-wide">
    <header class="wf-page-head">
      <div>
        <button
          v-if="route.query.from === 'reception'"
          class="wf-button"
          @click="router.push('/support/pipeline')"
        >← 返回接待编排</button>
        <h1>AI Employees</h1>
        <p>定义可发布、可回滚的 AI 员工，并在右侧把每个联系人绑定到具体的 AI Employee。</p>
      </div>
    </header>
    <div v-if="error" class="wf-error">
      <span>{{ error }}</span>
      <button class="wf-button compact" @click="load">重新加载</button>
    </div>
    <div v-if="bindingError" class="wf-error">
      <span>{{ bindingError }}</span>
    </div>

    <section class="wf-panel wf-employee-create">
      <div class="wf-panel-head">
        <h2>建立 AI Employee</h2>
        <span class="wf-section-caption">完整 Prompt 文本由版本管理</span>
      </div>
      <div class="wf-panel-body wf-grid">
        <div class="wf-field wf-span-4">
          <label>Key</label>
          <input v-model="newKey" class="wf-input" placeholder="product-support" />
        </div>
        <div class="wf-field wf-span-4">
          <label>名称</label>
          <input v-model="newName" class="wf-input" placeholder="产品支持顾问" />
        </div>
        <div class="wf-field wf-span-4">
          <label>说明</label>
          <input v-model="newDescription" class="wf-input" placeholder="处理产品故障与售后咨询" />
        </div>
        <div class="wf-field wf-span-12">
          <label>首个 Prompt 草稿</label>
          <textarea
            v-model="newPrompt"
            class="wf-textarea"
            rows="4"
            placeholder="描述这个 AI Employee 的工作目标、语气、业务范围与限制。"
          />
        </div>
        <div class="wf-span-12">
          <button
            class="wf-button primary"
            :disabled="creating || !newKey || !newName || !newPrompt"
            @click="createEmployee"
          >
            {{ creating ? "建立中" : "建立草稿" }}
          </button>
        </div>
      </div>
    </section>

    <div v-if="loading" class="wf-panel">
      <div class="wf-panel-body wf-skeleton">正在读取 AI Employee</div>
    </div>
    <div v-else class="wf-employee-grid">
      <aside class="wf-strategy-rail">
        <div class="wf-panel-head">
          <h2>AI Employee</h2>
          <span class="wf-section-caption">{{ employees.length }} 个</span>
        </div>
        <button
          v-for="employee in employees"
          :key="employee.definitionId"
          class="wf-side-row wf-side-button"
          :class="{ active: selectedId === employee.definitionId }"
          @click="selectEmployee(employee)"
        >
          <img
            v-if="employee.avatarUrl"
            :src="employee.avatarUrl"
            alt=""
            class="wf-employee-avatar"
          />
          <div class="wf-row-title">
            <span>{{ employee.name }}</span>
            <span
              class="wf-status"
              :class="employee.status === 'active' ? 'good' : 'warn'"
            >{{ employee.status === 'active' ? '启用' : '已归档' }}</span>
          </div>
          <div class="wf-row-preview">{{ employee.key }}</div>
          <div class="wf-row-meta">
            <span>{{ employee.versions.length }} 个版本</span>
            <span v-if="employee.definitionId === defaultId">共享默认</span>
          </div>
        </button>
        <div v-if="!employees.length" class="wf-empty">
          <div>
            <strong>还没有 AI Employee</strong>
            <p>先建立一个草稿，再发布给新建的 Agent Turn 使用。</p>
          </div>
        </div>
      </aside>

      <main v-if="selected" class="wf-object-sheet">
        <div class="wf-object-title">
          <div>
            <span
              class="wf-status"
              :class="selected.status === 'active' ? 'good' : 'warn'"
            >{{ selected.status === 'active' ? '启用' : '已归档' }}</span>
            <h2>{{ selected.name }}</h2>
            <span class="wf-mono wf-subtle">{{ selected.key }}</span>
          </div>
          <div class="wf-actions">
            <button
              v-if="selected.status === 'active'"
              class="wf-button"
              :disabled="saving"
              @click="archive"
            >归档</button>
            <button
              class="wf-button"
              :disabled="saving || selected.status !== 'active'"
              @click="createVersion"
            >新建版本</button>
          </div>
        </div>
        <section class="wf-object-section">
          <div class="wf-section-heading">
            <div>
              <span class="wf-eyebrow">共享工作空间默认</span>
              <h3>
                {{ defaultId === selected.definitionId ? '当前默认 AI Employee' : '可设为默认 AI Employee' }}
              </h3>
            </div>
            <select
              v-model="defaultId"
              class="wf-select"
              :disabled="selected.status !== 'active'"
              @change="changeDefault"
            >
              <option :value="null">Agent disabled（不设默认）</option>
              <option
                v-for="employee in activeEmployees"
                :key="employee.definitionId"
                :value="employee.definitionId"
              >{{ employee.name }}</option>
            </select>
          </div>
          <p class="wf-muted">联系人显式绑定优先于这里的共享默认；关闭 Contact Profile 的 Agent 开关仍然优先禁止创建 Turn。</p>
        </section>
        <section class="wf-object-section">
          <div class="wf-section-heading">
            <div>
              <span class="wf-eyebrow">版本</span>
              <h3>{{ selectedVersion ? versionLabel(selectedVersion) : '未选择版本' }}</h3>
            </div>
            <span v-if="publishedVersion" class="wf-status good">线上 {{ versionLabel(publishedVersion) }}</span>
          </div>
          <div class="wf-validation-results">
            <button
              v-for="version in selected.versions"
              :key="version.versionId"
              class="wf-case-row"
              :class="{ active: selectedVersionId === version.versionId }"
              @click="selectedVersionId = version.versionId"
            >
              <span class="wf-case-name">{{ versionLabel(version) }}</span>
              <span
                class="wf-case-state"
                :class="version.status === 'published' ? 'good' : version.status === 'draft' ? 'warn' : ''"
              >{{ version.status === 'published' ? '已发布' : version.status === 'draft' ? '草稿' : '已归档' }}</span>
              <span class="wf-case-reason">{{ new Date(version.createdAt).toLocaleString() }}</span>
            </button>
          </div>
        </section>
        <section v-if="selectedVersion" class="wf-object-section">
          <div class="wf-section-heading">
            <div>
              <span class="wf-eyebrow">Prompt Composition</span>
              <h3>工作指令</h3>
            </div>
            <div class="wf-actions">
              <button
                v-if="selectedVersion.status === 'draft' && !editing"
                class="wf-button"
                @click="beginEdit()"
              >编辑草稿</button>
              <button
                v-if="selectedVersion.status === 'retired'"
                class="wf-button"
                :disabled="saving"
                @click="rollback"
              >回滚为线上</button>
              <button
                v-if="selectedVersion.status === 'draft'"
                class="wf-button primary"
                :disabled="saving"
                @click="publish"
              >发布版本</button>
            </div>
          </div>
          <textarea v-if="editing" v-model="prompt" class="wf-textarea" rows="16" />
          <pre v-else class="wf-prompt-preview">{{ selectedVersion.prompt }}</pre>
          <div v-if="editing" class="wf-modal-foot">
            <button class="wf-button" @click="editing = false">取消</button>
            <button
              class="wf-button primary"
              :disabled="saving || !prompt.trim()"
              @click="saveDraft"
            >{{ saving ? '保存中' : '保存草稿' }}</button>
          </div>
          <p class="wf-muted">系统安全规则、回复策略和上下文会由 Core 统一组合；这里的文本不能覆盖它们。</p>
        </section>
      </main>
      <div v-else class="wf-empty">
        <div>
          <strong>选择一个 AI Employee</strong>
          <p>左侧选择定义，查看版本和 Prompt。</p>
        </div>
      </div>

      <aside class="wf-bindings-rail">
        <div class="wf-panel-head">
          <h2>联系人绑定</h2>
          <span class="wf-section-caption">{{ contacts.length }} 个联系人</span>
        </div>
        <div class="wf-panel-body">
          <input
            v-model="search"
            class="wf-input"
            placeholder="搜索联系人名称、备注或渠道 ID"
          />
        </div>
        <div v-if="!visibleContacts.length" class="wf-empty">
          <div>
            <strong>没有可绑定的联系人</strong>
            <p>联系人必须先通过 Channel Host 进入 Core。</p>
          </div>
        </div>
        <div v-else class="wf-binding-list">
          <div
            v-for="contact in visibleContacts"
            :key="contact.contactId"
            class="wf-binding-row"
          >
            <div class="wf-binding-name">
              <strong>{{ contactLabel(contact) }}</strong>
              <span class="wf-mono wf-subtle">{{ contact.contactId }}</span>
            </div>
            <div class="wf-binding-current">
              <span
                v-if="bindingMap.get(contact.contactId)"
                class="wf-status good"
              >{{ bindingMap.get(contact.contactId)?.definition.name }}</span>
              <span v-else class="wf-muted">使用共享默认</span>
            </div>
            <select
              class="wf-select"
              :disabled="savingBindingContactId === contact.contactId"
              :value="bindingMap.get(contact.contactId)?.definitionId ?? ''"
              @change="onBindingChange(contact.contactId, $event)"
            >
              <option value="">使用共享默认</option>
              <option
                v-for="employee in activeEmployees"
                :key="employee.definitionId"
                :value="employee.definitionId"
              >{{ employee.name }}</option>
            </select>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.wf-employee-create { margin-bottom: var(--wf-space-4); }
.wf-employee-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--wf-surface-soft, #eef2f7);
}
.wf-prompt-preview {
  margin: 0;
  padding: var(--wf-space-3);
  max-height: 420px;
  overflow: auto;
  color: var(--wf-text-secondary);
  background: var(--wf-surface-soft);
  white-space: pre-wrap;
  font: inherit;
  line-height: 1.7;
}
.wf-employee-grid {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
}
.wf-bindings-rail {
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  background: var(--wf-surface, #ffffff);
  display: flex;
  flex-direction: column;
  max-height: 720px;
  overflow: hidden;
}
.wf-binding-list {
  overflow: auto;
  padding: 8px 12px 16px;
}
.wf-binding-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.05));
}
.wf-binding-row:last-child { border-bottom: 0; }
.wf-binding-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  grid-column: 1;
  min-width: 0;
}
.wf-binding-name strong {
  font-size: 13px;
  color: var(--wf-text, #17181a);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-binding-current {
  grid-column: 1;
  font-size: 12px;
}
.wf-binding-row .wf-select {
  grid-column: 2;
  grid-row: 1 / span 2;
  min-width: 140px;
}
@media (max-width: 1100px) {
  .wf-employee-grid {
    grid-template-columns: 1fr;
  }
  .wf-bindings-rail { max-height: none; }
}
</style>
