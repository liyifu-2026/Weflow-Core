<script setup lang="ts">
const emit = defineEmits<{ saved: [] }>();

/**
 * 设置中心 · ② 模型分区：统一模型注册表 + 槽位绑定 + 健康状态。
 * 模型 = 名称 + 端点 + 密钥 + 能力标签（文本/视觉/语音）+ 故障转移链。
 * 保存后热生效（消费方 15s 轮询失效，无需重启）。
 */
import { onMounted, ref } from "vue";
import { api } from "../../api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  PlugZap,
  Plus,
} from "lucide-vue-next";

type ModelEntry = {
  modelId: string;
  displayName: string;
  baseUrl: string;
  hasApiKey: boolean;
  capabilities: string[];
  timeoutMs: number;
  failoverTo: string | null;
  enabled: boolean;
};

type ModelHealth = {
  modelId: string;
  displayName: string;
  lastSuccess: boolean | null;
  lastFailureReason: string | null;
  lastCheckedAt: number | null;
  successCount: number;
  failureCount: number;
};

type GatewayResponse = {
  models: ModelEntry[];
  slots: Record<string, string | null>;
  health: ModelHealth[];
};

const SLOTS: Array<{ key: string; label: string; desc: string }> = [
  {
    key: "text",
    label: "主力文本",
    desc: "AI 回复生成的主力模型；带「视觉」能力时同时负责识图",
  },
  {
    key: "vision",
    label: "视觉",
    desc: "识图兜底，仅当主力模型无视觉能力时使用；描述落库后复用",
  },
  { key: "asr", label: "语音转写", desc: "语音消息转文字专用小模型" },
  { key: "triage", label: "预判分流", desc: "高危/简单判定的极速小模型" },
  { key: "fast", label: "直答", desc: "简单题直答的轻量对话模型" },
];

/** reka-ui Select 不接受空字符串 value，「未绑定/无」用哨兵值表示 */
const NONE = "__none__";

const CAPABILITIES = ["text", "vision", "asr"] as const;
const CAPABILITY_LABELS: Record<string, string> = {
  text: "文本",
  vision: "视觉",
  asr: "语音",
};

const data = ref<GatewayResponse | null>(null);
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");
/** 新建表单 */
const creating = ref(false);
const newModel = ref({
  modelId: "",
  displayName: "",
  baseUrl: "",
  apiKey: "",
  capabilities: ["text"] as string[],
  timeoutMs: 60_000,
  failoverTo: "" as string | null,
});
/** 编辑中的条目：modelId → 草稿 */
const editing = ref<Record<string, Partial<ModelEntry> & { apiKey?: string }>>({});

/** 「测试连接」状态：modelId → 进行中 / 最近一次结果 */
const testing = ref<Record<string, boolean>>({});
type TestResult = { ok: boolean; text: string };
const testResults = ref<Record<string, TestResult>>({});

/**
 * 探测模型连接性：已保存模型直接测注册表端点；编辑表单打开时带表单值
 * （apiKey 留空则服务端沿用已存密钥），实现「先测再存」。
 */
async function testConnection(
  model: Pick<ModelEntry, "modelId"> & { baseUrl?: string },
  fromForm = false,
) {
  if (testing.value[model.modelId]) return;
  testing.value = { ...testing.value, [model.modelId]: true };
  try {
    const body: Record<string, unknown> = {};
    if (fromForm) {
      const patch = editing.value[model.modelId];
      if (patch?.baseUrl) body.baseUrl = patch.baseUrl;
      if (patch?.apiKey && patch.apiKey.trim() !== "")
        body.apiKey = patch.apiKey.trim();
      if (patch?.displayName) body.displayName = patch.displayName;
    }
    const result = await api<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
      firstProbe?: boolean;
    }>(
      `/api/v1/admin/model-gateway/models/${encodeURIComponent(model.modelId)}/test-connection`,
      { method: "POST", body: JSON.stringify(body), timeoutMs: 45_000 },
    );
    testResults.value = {
      ...testResults.value,
      [model.modelId]: result.ok
        ? {
            ok: true,
            text: `连接正常${result.latencyMs != null ? `（${result.latencyMs}ms）` : ""}`,
          }
        : { ok: false, text: `连接失败：${result.error ?? "未知错误"}` },
    };
    await load();
  } catch (reason) {
    testResults.value = {
      ...testResults.value,
      [model.modelId]: {
        ok: false,
        text:
          reason instanceof Error ? reason.message : "测试请求失败，请稍后重试",
      },
    };
  } finally {
    testing.value = { ...testing.value, [model.modelId]: false };
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await api<GatewayResponse>("/api/v1/admin/model-gateway");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模型网关加载失败";
  } finally {
    loading.value = false;
  }
}

function draft(model: ModelEntry) {
  return (
    editing.value[model.modelId] ?? {
      displayName: model.displayName,
      baseUrl: model.baseUrl,
      capabilities: [...model.capabilities],
      timeoutMs: model.timeoutMs,
      failoverTo: model.failoverTo,
      enabled: model.enabled,
      apiKey: "",
    }
  );
}

function startEdit(model: ModelEntry) {
  editing.value = { ...editing.value, [model.modelId]: draft(model) };
}

function cancelEdit(modelId: string) {
  const next = { ...editing.value };
  delete next[modelId];
  editing.value = next;
}

async function saveModel(model: ModelEntry) {
  const patch = editing.value[model.modelId];
  if (!patch || saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    const body: Record<string, unknown> = {
      displayName: patch.displayName,
      baseUrl: patch.baseUrl,
      capabilities: patch.capabilities,
      timeoutMs: patch.timeoutMs,
      failoverTo: patch.failoverTo || null,
      enabled: patch.enabled,
    };
    if (patch.apiKey && patch.apiKey.trim() !== "") {
      body.apiKey = patch.apiKey.trim();
    }
    await api(
      `/api/v1/admin/model-gateway/models/${encodeURIComponent(model.modelId)}`,
      { method: "PUT", body: JSON.stringify(body) },
    );
    cancelEdit(model.modelId);
    notice.value = "已保存；约 15 秒内生效，无需重启";
    emit("saved");
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模型保存失败";
  } finally {
    saving.value = false;
  }
}

async function createModel() {
  if (!newModel.value.modelId.trim() || !newModel.value.baseUrl.trim() || saving.value)
    return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    const body: Record<string, unknown> = {
      displayName: newModel.value.displayName || newModel.value.modelId,
      baseUrl: newModel.value.baseUrl.trim(),
      capabilities: newModel.value.capabilities,
      timeoutMs: newModel.value.timeoutMs,
      failoverTo: newModel.value.failoverTo || null,
      enabled: true,
    };
    if (newModel.value.apiKey.trim() !== "") {
      body.apiKey = newModel.value.apiKey.trim();
    }
    await api("/api/v1/admin/model-gateway/models/" + encodeURIComponent(newModel.value.modelId.trim()), {
      method: "PUT",
      body: JSON.stringify(body),
    });
    creating.value = false;
    newModel.value = {
      modelId: "",
      displayName: "",
      baseUrl: "",
      apiKey: "",
      capabilities: ["text"],
      timeoutMs: 60_000,
      failoverTo: null,
    };
    notice.value = "模型已创建";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "模型创建失败";
  } finally {
    saving.value = false;
  }
}

async function removeModel(model: ModelEntry) {
  if (!window.confirm(`删除模型「${model.displayName}」？槽位绑定将指向空。`)) return;
  saving.value = true;
  try {
    await api(`/api/v1/admin/model-gateway/models/${encodeURIComponent(model.modelId)}`, {
      method: "DELETE",
    });
    notice.value = "已删除";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "删除失败";
  } finally {
    saving.value = false;
  }
}

async function bindSlot(slot: string, modelId: string) {
  saving.value = true;
  error.value = "";
  try {
    await api(`/api/v1/admin/model-gateway/slots/${encodeURIComponent(slot)}`, {
      method: "PUT",
      body: JSON.stringify({ modelId: modelId || null }),
    });
    notice.value = "槽位已更新；约 15 秒内生效";
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "槽位绑定失败";
  } finally {
    saving.value = false;
  }
}

function healthOf(modelId: string): ModelHealth | undefined {
  return data.value?.health.find((h) => h.modelId === modelId);
}

type HealthTone = "secondary" | "destructive" | "outline";
function healthBadge(modelId: string): { text: string; tone: HealthTone } {
  const health = healthOf(modelId);
  if (!health || health.lastSuccess === null)
    return { text: "未探测", tone: "outline" };
  return health.lastSuccess
    ? { text: "正常", tone: "secondary" }
    : { text: "异常", tone: "destructive" };
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <!-- 模型槽位 -->
    <Card>
      <CardHeader>
        <CardTitle>模型槽位</CardTitle>
        <CardDescription>
          槽位决定各业务环节用哪个模型。绑定后从注册表取端点与密钥；未绑定的槽位回落
          .env 首次种子配置。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="loading" class="space-y-4">
          <Skeleton v-for="n in 3" :key="n" class="h-9 w-full" />
        </div>
        <Alert v-else-if="error" variant="destructive">
          <CircleAlert class="size-4" />
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
        <div v-else-if="data" class="space-y-4">
          <div
            v-for="slot in SLOTS"
            :key="slot.key"
            class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center"
          >
            <div class="space-y-0.5">
              <p class="text-sm font-medium leading-none">{{ slot.label }}</p>
              <p class="text-sm text-muted-foreground">{{ slot.desc }}</p>
            </div>
            <Select
              :model-value="data.slots[slot.key] || NONE"
              :disabled="saving"
              @update:model-value="
                bindSlot(slot.key, String($event) === NONE ? '' : String($event))
              "
            >
              <SelectTrigger class="w-full">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE">未绑定（回落 .env 种子）</SelectItem>
                <SelectItem
                  v-for="model in data.models.filter((m) => m.enabled)"
                  :key="model.modelId"
                  :value="model.modelId"
                >
                  {{ model.displayName }}（{{ model.modelId }}）
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 模型注册表 -->
    <Card>
      <CardHeader>
        <CardTitle>模型注册表</CardTitle>
        <CardDescription>
          统一维护端点与密钥；保存后约 15 秒内热生效，无需重启。
        </CardDescription>
        <CardAction>
          <Button
            :variant="creating ? 'outline' : 'default'"
            size="sm"
            @click="creating = !creating"
          >
            <Plus class="size-4" />
            {{ creating ? "取消新建" : "新建模型" }}
          </Button>
        </CardAction>
      </CardHeader>

      <!-- 新建表单 -->
      <CardContent v-if="creating" class="border-t pt-6">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label for="new-model-id">模型 ID</Label>
            <Input id="new-model-id" v-model="newModel.modelId" placeholder="model-id" />
            <p class="text-xs text-muted-foreground">唯一标识（如 deepseek-v4-flash）</p>
          </div>
          <div class="space-y-2">
            <Label for="new-model-name">模型名</Label>
            <Input
              id="new-model-name"
              v-model="newModel.displayName"
              placeholder="deepseek-v4-flash"
            />
            <p class="text-xs text-muted-foreground">请求上游时使用的模型名</p>
          </div>
          <div class="space-y-2 sm:col-span-2">
            <Label for="new-model-url">端点 Base URL</Label>
            <Input
              id="new-model-url"
              v-model="newModel.baseUrl"
              placeholder="https://api.example.com/v1"
            />
          </div>
          <div class="space-y-2 sm:col-span-2">
            <Label for="new-model-key">API Key</Label>
            <Input
              id="new-model-key"
              v-model="newModel.apiKey"
              type="password"
              placeholder="sk-…"
            />
          </div>
          <div class="space-y-2">
            <Label>能力标签</Label>
            <div class="flex gap-4">
              <label
                v-for="cap in CAPABILITIES"
                :key="cap"
                class="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  :checked="newModel.capabilities.includes(cap)"
                  @update:checked="
                    (checked: boolean | 'indeterminate') =>
                      (newModel.capabilities = checked
                        ? [...newModel.capabilities, cap]
                        : newModel.capabilities.filter((c) => c !== cap))
                  "
                />
                {{ CAPABILITY_LABELS[cap] }}
              </label>
            </div>
          </div>
          <div class="space-y-2">
            <Label>故障转移</Label>
            <Select
              :model-value="newModel.failoverTo || NONE"
              :disabled="!data"
              @update:model-value="
                (value: unknown) =>
                  (newModel.failoverTo = value === NONE ? '' : String(value))
              "
            >
              <SelectTrigger class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="NONE">无</SelectItem>
                <SelectItem
                  v-for="model in data?.models ?? []"
                  :key="model.modelId"
                  :value="model.modelId"
                >
                  {{ model.displayName }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">主模型失败/超时自动切到该模型</p>
          </div>
          <div class="sm:col-span-2">
            <Button
              :disabled="saving || !newModel.modelId.trim() || !newModel.baseUrl.trim()"
              @click="createModel"
            >
              {{ saving ? "创建中…" : "创建模型" }}
            </Button>
          </div>
        </div>
      </CardContent>

      <!-- 提示 / 错误 -->
      <CardContent v-if="error && !creating" class="border-t pt-6">
        <Alert variant="destructive">
          <CircleAlert class="size-4" />
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
      </CardContent>
      <CardContent v-if="notice" class="border-t pt-6">
        <p class="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck class="size-4" />
          {{ notice }}
        </p>
      </CardContent>

      <!-- 列表 -->
      <CardContent v-if="loading && !data" class="space-y-3 border-t pt-6">
        <Skeleton v-for="n in 2" :key="n" class="h-16 w-full" />
      </CardContent>

      <CardContent v-else-if="data && data.models.length" class="border-t">
        <div class="divide-y">
          <div
            v-for="model in data.models"
            :key="model.modelId"
            class="py-4 first:pt-6 last:pb-6"
          >
            <div v-if="!editing[model.modelId]">
              <div class="flex flex-wrap items-center gap-2">
                <Badge :variant="healthBadge(model.modelId).tone">
                  {{ healthBadge(model.modelId).text }}
                </Badge>
                <span class="text-sm font-medium">{{ model.displayName }}</span>
                <code class="font-mono text-xs text-muted-foreground">
                  {{ model.modelId }}
                </code>
                <Badge v-if="!model.enabled" variant="outline">已禁用</Badge>
                <span class="grow" />
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="testing[model.modelId]"
                  @click="testConnection(model)"
                >
                  <PlugZap class="size-4" />
                  {{ testing[model.modelId] ? "测试中…" : "测试连接" }}
                </Button>
                <Button variant="ghost" size="sm" @click="startEdit(model)">
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  class="text-destructive hover:text-destructive"
                  :disabled="saving"
                  @click="removeModel(model)"
                >
                  删除
                </Button>
              </div>
              <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{{ model.baseUrl }}</span>
                <span>
                  {{ model.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(" / ") || "无标签" }}
                </span>
                <span v-if="model.failoverTo">故障转移 → {{ model.failoverTo }}</span>
                <span>超时 {{ Math.round(model.timeoutMs / 1000) }}s</span>
                <span>{{ model.hasApiKey ? "密钥已配置" : "无密钥" }}</span>
              </div>
              <p
                v-if="testResults[model.modelId]"
                class="mt-1.5 flex items-center gap-1.5 text-xs"
                :class="testResults[model.modelId]!.ok ? 'text-emerald-600' : 'text-destructive'"
              >
                <CircleCheck v-if="testResults[model.modelId]!.ok" class="size-3.5" />
                <CircleX v-else class="size-3.5" />
                {{ testResults[model.modelId]!.text }}
              </p>
            </div>

            <!-- 编辑表单 -->
            <div v-else class="space-y-4">
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-2">
                  <Label :for="`edit-name-${model.modelId}`">模型名</Label>
                  <Input
                    :id="`edit-name-${model.modelId}`"
                    v-model="editing[model.modelId]!.displayName"
                  />
                </div>
                <div class="space-y-2">
                  <Label :for="`edit-url-${model.modelId}`">端点 Base URL</Label>
                  <Input
                    :id="`edit-url-${model.modelId}`"
                    v-model="editing[model.modelId]!.baseUrl"
                  />
                </div>
                <div class="space-y-2">
                  <Label :for="`edit-key-${model.modelId}`">API Key</Label>
                  <Input
                    :id="`edit-key-${model.modelId}`"
                    v-model="editing[model.modelId]!.apiKey"
                    type="password"
                    placeholder="留空保持不变"
                  />
                  <p class="text-xs text-muted-foreground">
                    {{ model.hasApiKey ? "已配置；留空保持不变" : "未配置" }}
                  </p>
                </div>
                <div class="space-y-2">
                  <Label>能力标签</Label>
                  <div class="flex gap-4 pt-1">
                    <label
                      v-for="cap in CAPABILITIES"
                      :key="cap"
                      class="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        :checked="(editing[model.modelId]!.capabilities ?? []).includes(cap)"
                        @update:checked="
                          (checked: boolean | 'indeterminate') => {
                            const caps = editing[model.modelId]!.capabilities ?? [];
                            editing[model.modelId]!.capabilities = checked
                              ? [...caps, cap]
                              : caps.filter((c) => c !== cap);
                          }
                        "
                      />
                      {{ CAPABILITY_LABELS[cap] }}
                    </label>
                  </div>
                </div>
                <div class="space-y-2">
                  <Label>故障转移</Label>
                  <Select
                    :model-value="editing[model.modelId]!.failoverTo || NONE"
                    @update:model-value="
                      (value: unknown) =>
                        (editing[model.modelId]!.failoverTo =
                          value === NONE ? null : String(value))
                    "
                  >
                    <SelectTrigger class="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="NONE">无</SelectItem>
                      <SelectItem
                        v-for="other in data!.models.filter((m) => m.modelId !== model.modelId)"
                        :key="other.modelId"
                        :value="other.modelId"
                      >
                        {{ other.displayName }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="flex items-center gap-2">
                  <Switch
                    :id="`edit-enabled-${model.modelId}`"
                    v-model="editing[model.modelId]!.enabled as unknown as boolean"
                  />
                  <Label :for="`edit-enabled-${model.modelId}`">启用</Label>
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="testing[model.modelId]"
                  @click="testConnection(model, true)"
                >
                  <PlugZap class="size-4" />
                  {{ testing[model.modelId] ? "测试中…" : "测试连接" }}
                </Button>
                <Button variant="outline" size="sm" @click="cancelEdit(model.modelId)">
                  取消
                </Button>
                <Button size="sm" :disabled="saving" @click="saveModel(model)">
                  {{ saving ? "保存中…" : "保存" }}
                </Button>
              </div>
              <p
                v-if="testResults[model.modelId]"
                class="text-right text-xs"
                :class="testResults[model.modelId]!.ok ? 'text-emerald-600' : 'text-destructive'"
              >
                {{ testResults[model.modelId]!.text }}
              </p>
            </div>
          </div>
        </div>
      </CardContent>

      <!-- 空状态 -->
      <CardContent v-else-if="data" class="border-t">
        <div class="flex flex-col items-center gap-1 py-10 text-center">
          <CircleX class="size-8 text-muted-foreground/60" />
          <p class="text-sm font-medium">注册表为空</p>
          <p class="text-sm text-muted-foreground">
            新建模型并绑定槽位；未绑定时回落 .env 首次种子配置（仅首次部署生效）。
          </p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
