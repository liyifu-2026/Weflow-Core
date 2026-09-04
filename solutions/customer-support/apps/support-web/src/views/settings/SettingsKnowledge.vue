<script setup lang="ts">
/**
 * 设置中心 · ③ 知识库分区：通用 RESTful 连接器。
 * 连接器类型 / 检索端点 / 认证方式 / 请求响应字段映射 JSON / 管理端点可选。
 * WeKnora 为预设模板；配置存扩展设置 knowledgeConnector 键。
 */
import { onMounted, ref } from "vue";
import { CircleAlert, CircleCheck, Wand2 } from "lucide-vue-next";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  readPipelineSettings,
  writePipelineSettings,
} from "./common";

type ConnectorConfig = {
  type: string;
  retrieveUrl: string;
  authMode: "none" | "bearer" | "header";
  authHeader: string;
  authValue: string;
  requestMapping: string;
  responseMapping: string;
  adminUrl: string;
};

const WEKNORA_TEMPLATE: ConnectorConfig = {
  type: "weknora",
  retrieveUrl: "",
  authMode: "bearer",
  authHeader: "Authorization",
  authValue: "",
  requestMapping: '{"query":"$.query","knowledgeBaseIds":"$.knowledge_base_ids"}',
  responseMapping: '{"evidence":"$.data[*]","chunkId":"$.chunk_id","content":"$.content","score":"$.score"}',
  adminUrl: "",
};

const DEFAULTS: ConnectorConfig = {
  type: "",
  retrieveUrl: "",
  authMode: "none",
  authHeader: "",
  authValue: "",
  requestMapping: "",
  responseMapping: "",
  adminUrl: "",
};

const AUTH_MODES: Array<{ value: ConnectorConfig["authMode"]; label: string }> = [
  { value: "none", label: "无" },
  { value: "bearer", label: "Bearer Token" },
  { value: "header", label: "自定义 Header" },
];

const config = ref<ConnectorConfig>({ ...DEFAULTS });
const rawSettings = ref<Record<string, unknown>>({});
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");

function apply(raw: unknown) {
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const str = (value: unknown, fallback: string) =>
    typeof value === "string" ? value : fallback;
  config.value = {
    type: str(source.type, DEFAULTS.type),
    retrieveUrl: str(source.retrieveUrl, DEFAULTS.retrieveUrl),
    authMode:
      source.authMode === "bearer" || source.authMode === "header"
        ? source.authMode
        : "none",
    authHeader: str(source.authHeader, DEFAULTS.authHeader),
    authValue: str(source.authValue, DEFAULTS.authValue),
    requestMapping: str(source.requestMapping, DEFAULTS.requestMapping),
    responseMapping: str(source.responseMapping, DEFAULTS.responseMapping),
    adminUrl: str(source.adminUrl, DEFAULTS.adminUrl),
  };
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rawSettings.value = await readPipelineSettings();
    apply(rawSettings.value.knowledgeConnector);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "连接器配置加载失败";
  } finally {
    loading.value = false;
  }
}

function applyTemplate() {
  if (!window.confirm("用 WeKnora 预设模板覆盖当前表单？")) return;
  config.value = { ...WEKNORA_TEMPLATE };
  notice.value = "已填充 WeKnora 预设模板（保存后生效）";
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    for (const field of ["requestMapping", "responseMapping"] as const) {
      const text = config.value[field].trim();
      if (text) JSON.parse(text);
    }
  } catch {
    error.value = "字段映射不是合法 JSON，请修正后再保存";
    saving.value = false;
    return;
  }
  try {
    await writePipelineSettings({
      ...rawSettings.value,
      knowledgeConnector: { ...config.value },
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
    <Card>
      <CardHeader>
        <CardTitle>知识库连接器</CardTitle>
        <CardDescription>
          通用 RESTful 连接器：AI 检索时按下方端点与字段映射调用外部知识库。
          知识库内容管理（上传/文档/分块）请使用外部知识库原生界面（会话工作台的
          「知识库」页为只读验证视图）。
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" @click="applyTemplate">
            <Wand2 class="size-4" />
            填充 WeKnora 预设
          </Button>
        </CardAction>
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

          <div class="grid gap-5 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="kb-type">连接器类型</Label>
              <Input
                id="kb-type"
                v-model="config.type"
                placeholder="weknora / custom-rest"
              />
              <p class="text-xs text-muted-foreground">标识用途；weknora 为预设模板。</p>
            </div>
            <div class="space-y-2 sm:col-span-2">
              <Label for="kb-url">检索端点 URL</Label>
              <Input
                id="kb-url"
                v-model="config.retrieveUrl"
                placeholder="https://kb.example.com/api/search"
              />
              <p class="text-xs text-muted-foreground">
                接收 {query, knowledgeBaseIds} 的 POST 端点；留空 = 不接外部知识库。
              </p>
            </div>
            <div class="space-y-2">
              <Label>认证方式</Label>
              <div class="flex gap-4 pt-1">
                <label
                  v-for="mode in AUTH_MODES"
                  :key="mode.value"
                  class="flex items-center gap-2 text-sm"
                >
                  <input
                    v-model="config.authMode"
                    type="radio"
                    :value="mode.value"
                    class="size-4 accent-[var(--primary)]"
                  />
                  {{ mode.label }}
                </label>
              </div>
            </div>
            <div v-if="config.authMode === 'header'" class="space-y-2">
              <Label for="kb-header">Header 名</Label>
              <Input id="kb-header" v-model="config.authHeader" placeholder="X-Api-Key" />
            </div>
            <div v-if="config.authMode !== 'none'" class="space-y-2">
              <Label for="kb-cred">凭据</Label>
              <Input
                id="kb-cred"
                v-model="config.authValue"
                type="password"
                placeholder="留空保持不变"
              />
              <p class="text-xs text-muted-foreground">保存后不回显；留空保持原值。</p>
            </div>
            <div class="space-y-2 sm:col-span-2">
              <Label for="kb-req">请求字段映射 JSON</Label>
              <Textarea id="kb-req" v-model="config.requestMapping" rows="2" class="font-mono text-xs" />
              <p class="text-xs text-muted-foreground">
                本地查询 → 上游请求体（JSONPath 风格声明）。
              </p>
            </div>
            <div class="space-y-2 sm:col-span-2">
              <Label for="kb-resp">响应字段映射 JSON</Label>
              <Textarea id="kb-resp" v-model="config.responseMapping" rows="2" class="font-mono text-xs" />
              <p class="text-xs text-muted-foreground">上游响应 → 本地证据结构。</p>
            </div>
            <div class="space-y-2 sm:col-span-2">
              <Label for="kb-admin">管理端点 URL（可选）</Label>
              <Input
                id="kb-admin"
                v-model="config.adminUrl"
                placeholder="https://kb.example.com/api"
              />
              <p class="text-xs text-muted-foreground">
                RESTful 管理接口；当前版本仅登记，不在界面内管理内容。
              </p>
            </div>
          </div>

          <div>
            <Button type="submit" :disabled="saving">
              {{ saving ? "保存中…" : "保存连接器" }}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
