<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Archive,
  CircleAlert,
  Plus,
  RotateCcw,
  Search,
  UserRound,
  Loader2,
  Trash2,
} from "lucide-vue-next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
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
import { confirmDialog } from "../components/confirm-dialog";
import AvatarImage from "../components/AvatarImage.vue";

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
// 弹窗可见性与提交进行中是两个状态：creating 只表示请求在途，
// 否则弹窗一打开按钮就常驻「建立中」且被禁用，表单永远无法提交。
const createOpen = ref(false);
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

function contactLabel(contact: ContactSummary) {
  return contactDisplayName({ contact });
}

function statusBadge(status: string) {
  return status === "active"
    ? { text: "启用", variant: "secondary" as const }
    : { text: "已归档", variant: "outline" as const };
}

function versionBadge(status: string) {
  if (status === "published")
    return { text: "已发布", variant: "secondary" as const };
  if (status === "draft") return { text: "草稿", variant: "outline" as const };
  return { text: "已归档", variant: "outline" as const };
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
    createOpen.value = false;
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
  if (!(await confirmDialog("发布后，新创建的 Agent Turn 将使用此版本。确认发布？", { danger: true }))) return;
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
  if (!(await confirmDialog("将这个历史版本恢复为线上版本？"))) return;
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
  if (!selected.value || !(await confirmDialog("归档这个 AI Employee？归档后不会再作为默认绑定解析。", { danger: true }))) return;
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

async function changeDefault(value: string) {
  defaultId.value = value || null;
  try {
    await setWorkspaceAgentDefault(defaultId.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "默认 AI Employee 设置失败";
  }
}

// ---- 员工服务名单（以员工为中心的绑定，UX-DECISIONS §4）----
// 名单 = 显式绑定到当前员工的联系人；名单外联系人走共享默认。
const roster = computed(() =>
  contacts.value.filter(
    (c) => bindingMap.value.get(c.contactId)?.definitionId === selectedId.value,
  ),
);
// 可添加：未绑定到当前员工的联系人，按搜索词过滤
const addableContacts = computed(() => {
  const q = search.value.trim().toLowerCase();
  return contacts.value.filter((c) => {
    if (bindingMap.value.get(c.contactId)?.definitionId === selectedId.value)
      return false;
    if (!q) return true;
    return (
      contactLabel(c).toLowerCase().includes(q) ||
      c.contactId.toLowerCase().includes(q)
    );
  });
});

async function addRosterMember(contactId: string) {
  if (!selectedId.value) return;
  savingBindingContactId.value = contactId;
  bindingError.value = "";
  try {
    await setContactAgentBinding(contactId, selectedId.value);
    await load();
  } catch (reason) {
    bindingError.value =
      reason instanceof Error ? reason.message : "添加绑定失败";
  } finally {
    savingBindingContactId.value = "";
  }
}

async function removeRosterMember(contactId: string) {
  savingBindingContactId.value = contactId;
  bindingError.value = "";
  try {
    await removeContactAgentBinding(contactId);
    await load();
  } catch (reason) {
    bindingError.value =
      reason instanceof Error ? reason.message : "移除绑定失败";
  } finally {
    savingBindingContactId.value = "";
  }
}

function versionLabel(version: AiEmployeeVersion) {
  return `v${version.version}`;
}

onMounted(load);
</script>

<template>
  <div class="mx-auto w-full max-w-6xl p-6">
    <header class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight">AI Employees</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        定义可发布、可回滚的 AI 员工；选中后在右侧维护它的服务名单。
      </p>
    </header>

    <Alert v-if="error" variant="destructive" class="mb-4">
      <CircleAlert class="size-4" />
      <AlertDescription class="flex flex-wrap items-center gap-3">
        {{ error }}
        <Button variant="outline" size="sm" class="ml-auto" @click="load">
          重新加载
        </Button>
      </AlertDescription>
    </Alert>
    <Alert v-if="bindingError" variant="destructive" class="mb-4">
      <CircleAlert class="size-4" />
      <AlertDescription>{{ bindingError }}</AlertDescription>
    </Alert>

    <!-- loading -->
    <div v-if="loading" class="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
      <Skeleton class="h-72 w-full" />
      <Skeleton class="h-72 w-full" />
      <Skeleton class="h-72 w-full" />
    </div>

    <!-- 三栏 -->
    <div v-else class="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_320px] lg:items-start">
      <!-- 左：员工列表 -->
      <Card>
        <CardHeader>
          <CardTitle class="text-base">AI Employee</CardTitle>
          <CardDescription>{{ employees.length }} 个</CardDescription>
          <CardAction>
            <Button size="sm" @click="createOpen = true">
              <Plus class="size-4" />
              新建
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent class="p-2 pt-0">
          <div v-if="!employees.length" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <UserRound class="size-8 text-muted-foreground/60" />
            <p class="text-sm font-medium">还没有 AI Employee</p>
            <p class="text-sm text-muted-foreground">
              先建立一个草稿，再发布给新建的 Agent Turn 使用。
            </p>
            <Button size="sm" variant="outline" class="mt-1" @click="createOpen = true">
              <Plus class="size-4" />
              新建 AI Employee
            </Button>
          </div>
          <button
            v-for="employee in employees"
            :key="employee.definitionId"
            type="button"
            class="flex w-full flex-col gap-0.5 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent"
            :class="cn(selectedId === employee.definitionId && 'bg-accent')"
            @click="selectEmployee(employee)"
          >
            <span class="flex items-center gap-2">
              <img
                v-if="employee.avatarUrl"
                :src="employee.avatarUrl"
                alt=""
                class="size-7 shrink-0 rounded-full object-cover"
              />
              <span class="min-w-0 flex-1 truncate text-sm font-medium">
                {{ employee.name }}
              </span>
              <Badge :variant="statusBadge(employee.status).variant">
                {{ statusBadge(employee.status).text }}
              </Badge>
            </span>
            <span class="truncate font-mono text-xs text-muted-foreground">
              {{ employee.key }}
            </span>
            <span class="text-xs text-muted-foreground">
              {{ employee.versions.length }} 个版本
              <span v-if="employee.definitionId === defaultId"> · 共享默认</span>
            </span>
          </button>
        </CardContent>
      </Card>

      <!-- 中：详情 -->
      <Card v-if="selected" class="min-w-0">
        <CardHeader>
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="statusBadge(selected.status).variant">
              {{ statusBadge(selected.status).text }}
            </Badge>
            <CardTitle>{{ selected.name }}</CardTitle>
            <code class="font-mono text-xs text-muted-foreground">{{ selected.key }}</code>
          </div>
          <CardAction class="flex gap-2">
            <Button
              v-if="selected.status === 'active'"
              variant="ghost"
              size="sm"
              :disabled="saving"
              @click="archive"
            >
              <Archive class="size-4" />
              归档
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="saving || selected.status !== 'active'"
              @click="createVersion"
            >
              <Plus class="size-4" />
              新建版本
            </Button>
          </CardAction>
        </CardHeader>

        <!-- 共享默认 -->
        <CardContent class="space-y-1.5 border-t py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <Label for="emp-default" class="text-sm font-medium">
              共享工作空间默认
            </Label>
            <Select
              :model-value="defaultId ?? ''"
              :disabled="selected.status !== 'active'"
              @update:model-value="changeDefault(String($event))"
            >
              <SelectTrigger id="emp-default" class="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Agent disabled（不设默认）</SelectItem>
                <SelectItem
                  v-for="employee in activeEmployees"
                  :key="employee.definitionId"
                  :value="employee.definitionId"
                >
                  {{ employee.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p class="text-sm text-muted-foreground">
            联系人显式绑定优先于这里的共享默认；关闭 Contact Profile 的 Agent 开关仍然优先禁止创建
            Turn。
          </p>
        </CardContent>

        <!-- 版本 -->
        <CardContent class="space-y-3 border-t py-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <Label class="text-sm font-medium">
              版本：{{ selectedVersion ? versionLabel(selectedVersion) : "未选择版本" }}
            </Label>
            <Badge v-if="publishedVersion" variant="secondary">
              线上 {{ versionLabel(publishedVersion) }}
            </Badge>
          </div>
          <div class="space-y-1">
            <button
              v-for="version in selected.versions"
              :key="version.versionId"
              type="button"
              class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
              :class="cn(selectedVersionId === version.versionId && 'bg-accent')"
              @click="selectedVersionId = version.versionId"
            >
              <span class="w-12 shrink-0 font-mono text-sm">
                {{ versionLabel(version) }}
              </span>
              <Badge :variant="versionBadge(version.status).variant">
                {{ versionBadge(version.status).text }}
              </Badge>
              <span class="ml-auto text-xs text-muted-foreground">
                {{ new Date(version.createdAt).toLocaleString() }}
              </span>
            </button>
          </div>
        </CardContent>

        <!-- Prompt -->
        <CardContent v-if="selectedVersion" class="space-y-3 border-t py-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <Label class="text-sm font-medium">工作指令（Prompt）</Label>
            <div class="flex gap-2">
              <Button
                v-if="selectedVersion.status === 'draft' && !editing"
                variant="outline"
                size="sm"
                @click="beginEdit()"
              >
                编辑草稿
              </Button>
              <Button
                v-if="selectedVersion.status === 'retired'"
                variant="ghost"
                size="sm"
                :disabled="saving"
                @click="rollback"
              >
                <RotateCcw class="size-4" />
                回滚为线上
              </Button>
              <Button
                v-if="selectedVersion.status === 'draft'"
                size="sm"
                :disabled="saving"
                @click="publish"
              >
                发布版本
              </Button>
            </div>
          </div>
          <Textarea v-if="editing" v-model="prompt" rows="16" class="font-mono text-xs" />
          <pre
            v-else
            class="max-h-[420px] overflow-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap"
          >{{ selectedVersion.prompt }}</pre>
          <div v-if="editing" class="flex justify-end gap-2">
            <Button variant="outline" size="sm" @click="editing = false">取消</Button>
            <Button size="sm" :disabled="saving || !prompt.trim()" @click="saveDraft">
              {{ saving ? "保存中" : "保存草稿" }}
            </Button>
          </div>
          <p class="text-sm text-muted-foreground">
            系统安全规则、回复策略和上下文会由 Core 统一组合；这里的文本不能覆盖它们。
          </p>
        </CardContent>
      </Card>

      <!-- 中：空态 -->
      <Card v-else class="flex min-h-72 items-center justify-center">
        <CardContent class="flex flex-col items-center gap-1 py-10 text-center">
          <UserRound class="size-8 text-muted-foreground/60" />
          <p class="text-sm font-medium">选择一个 AI Employee</p>
          <p class="text-sm text-muted-foreground">左侧选择定义，查看版本和 Prompt。</p>
        </CardContent>
      </Card>

      <!-- 右：服务名单（以员工为中心的绑定，UX-DECISIONS §4） -->
      <Card class="lg:sticky lg:top-6">
        <CardHeader>
          <CardTitle class="text-base">服务名单</CardTitle>
          <CardDescription>
            {{ selected ? `由「${selected.name}」服务的联系人` : "先在左侧选择 AI Employee" }}
          </CardDescription>
        </CardHeader>
        <CardContent class="border-t p-3">
          <div class="relative">
            <Search
              class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              v-model="search"
              placeholder="搜索联系人并加入名单"
              class="pl-8"
              :disabled="!selected"
            />
          </div>
          <p class="mt-1.5 text-xs text-muted-foreground">
            名单外的联系人使用共享工作空间默认。
          </p>
        </CardContent>
        <CardContent class="max-h-[560px] overflow-auto p-3 pt-0">
          <Alert v-if="bindingError" variant="destructive" class="mb-2">
            <AlertDescription class="text-xs">{{ bindingError }}</AlertDescription>
          </Alert>

          <!-- 名单 -->
          <div
            v-if="!selected"
            class="flex flex-col items-center gap-1 py-10 text-center"
          >
            <p class="text-sm font-medium">未选择 AI Employee</p>
            <p class="text-sm text-muted-foreground">左侧选择后即可维护服务名单。</p>
          </div>
          <div v-else-if="!roster.length" class="py-6 text-center">
            <p class="text-sm font-medium">名单还是空的</p>
            <p class="mt-1 text-xs text-muted-foreground">
              用上方搜索把联系人加入该员工的服务名单。
            </p>
          </div>
          <div v-else class="divide-y">
            <div
              v-for="contact in roster"
              :key="contact.contactId"
              class="flex items-center gap-2 py-2.5"
            >
              <AvatarImage
                :contact-id="contact.contactId"
                :fallback-text="contactLabel(contact)"
                :size="28"
              />
              <span class="min-w-0 flex-1 truncate text-sm font-medium">
                {{ contactLabel(contact) }}
              </span>
              <Button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0 text-destructive hover:text-destructive"
                title="移出名单"
                :disabled="savingBindingContactId === contact.contactId"
                @click="removeRosterMember(contact.contactId)"
              >
                <Trash2 class="size-3.5" />
              </Button>
            </div>
          </div>

          <!-- 可添加（搜索过滤） -->
          <template v-if="selected && addableContacts.length">
            <div class="border-t border-border pb-1 pt-3 text-xs font-semibold text-muted-foreground">
              可添加
            </div>
            <div class="divide-y">
              <button
                v-for="contact in addableContacts.slice(0, 20)"
                :key="contact.contactId"
                type="button"
                class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
                :disabled="savingBindingContactId === contact.contactId"
                @click="addRosterMember(contact.contactId)"
              >
                <AvatarImage
                  :contact-id="contact.contactId"
                  :fallback-text="contactLabel(contact)"
                  :size="24"
                />
                <span class="min-w-0 flex-1 truncate text-sm">{{ contactLabel(contact) }}</span>
                <Loader2
                  v-if="savingBindingContactId === contact.contactId"
                  class="size-3.5 shrink-0 animate-spin text-muted-foreground"
                />
                <Plus v-else class="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </div>
            <p
              v-if="addableContacts.length > 20 && !search.trim()"
              class="pt-2 text-xs text-muted-foreground"
            >
              共 {{ addableContacts.length }} 人可添加，输入关键词缩小范围。
            </p>
          </template>
        </CardContent>
      </Card>
    </div>

    <Separator class="opacity-0" />
  </div>
    <!-- 新建 AI Employee（Dialog） -->
    <Dialog :open="createOpen" @update:open="(v: boolean) => (createOpen = v)">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>建立 AI Employee</DialogTitle>
          <DialogDescription>完整 Prompt 文本由版本管理。</DialogDescription>
        </DialogHeader>
        <form class="grid gap-4" @submit.prevent="createEmployee">
          <div class="space-y-2">
            <Label for="new-emp-key">Key</Label>
            <Input id="new-emp-key" v-model="newKey" placeholder="product-support" />
          </div>
          <div class="space-y-2">
            <Label for="new-emp-name">名称</Label>
            <Input id="new-emp-name" v-model="newName" placeholder="产品支持顾问" />
          </div>
          <div class="space-y-2">
            <Label for="new-emp-desc">说明</Label>
            <Input
              id="new-emp-desc"
              v-model="newDescription"
              placeholder="处理产品故障与售后咨询"
            />
          </div>
          <div class="space-y-2">
            <Label for="new-emp-prompt">首个 Prompt 草稿</Label>
            <Textarea
              id="new-emp-prompt"
              v-model="newPrompt"
              rows="6"
              placeholder="描述这个 AI Employee 的工作目标、语气、业务范围与限制。"
            />
          </div>
          <!-- 失败原因就地展示：页面级 Alert 会被弹窗遮罩挡住，看起来像"卡住" -->
          <Alert v-if="error" variant="destructive">
            <CircleAlert class="size-4" />
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" @click="createOpen = false">
              取消
            </Button>
            <Button type="submit" :disabled="creating || !newKey || !newName || !newPrompt">
              {{ creating ? "建立中" : "建立草稿" }}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
</template>
