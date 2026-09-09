<script setup lang="ts">
const emit = defineEmits<{ saved: [] }>();

/**
 * 设置中心 · ① AI员工分区：员工管理入口 + 行为参数。
 * 行为参数（R2）：会话 TTL/轮数上限/wait 上限/nudge 话术/ReAct 预算，
 * 存扩展设置 behavior 键，agent-worker 30s TTL 缓存热读，无需重启。
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ArrowUpRight } from "lucide-vue-next";
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
    emit("saved");
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
    <!-- AI 员工入口 -->
    <Card>
      <CardHeader>
        <CardTitle>AI 员工</CardTitle>
        <CardDescription>
          人格（Prompt 版本）、分工（联系人绑定）、能力（工具开关）在员工管理页维护；
          未绑定联系人的会话走默认员工。
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" @click="router.push('/ai-employees')">
            管理员工
            <ArrowUpRight class="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-muted-foreground">
          模式说明：深思模式 = ReAct 预算 {{ config.toolStepBudget }} 步 + 思维链展示；
          直答模式 = 预算 1（预判分流 simple 档直答）。
        </p>
      </CardContent>
    </Card>

    <!-- 行为参数 -->
    <Card>
      <CardHeader>
        <CardTitle>行为参数</CardTitle>
        <CardDescription v-if="notice">已保存；30 秒内生效（无需重启）</CardDescription>
        <CardDescription v-else-if="error" class="text-destructive">
          {{ error }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="loading" class="space-y-4">
          <Skeleton v-for="n in 4" :key="n" class="h-9 w-full" />
        </div>
        <form v-else class="space-y-5" @submit.prevent="save">
          <div class="grid gap-5 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="behavior-ttl">会话 TTL（分钟）</Label>
              <Input
                id="behavior-ttl"
                v-model.number="config.sessionTtlMinutes"
                type="number"
                min="5"
                max="1440"
              />
              <p class="text-xs text-muted-foreground">
                会话片段超时强制收束的分钟数（默认 45）。
              </p>
            </div>
            <div class="space-y-2">
              <Label for="behavior-rounds">每会话轮数上限</Label>
              <Input
                id="behavior-rounds"
                v-model.number="config.sessionRoundBudget"
                type="number"
                min="1"
                max="200"
              />
              <p class="text-xs text-muted-foreground">
                预算耗尽强制收束，防「永不结束的会话」（默认 24）。
              </p>
            </div>
            <div class="space-y-2">
              <Label for="behavior-wait">wait 缺省等待（秒）</Label>
              <Input
                id="behavior-wait"
                :value="Math.round(config.defaultWaitMs / 1000)"
                type="number"
                min="30"
                max="900"
                @input="
                  config.defaultWaitMs =
                    Number(($event.target as HTMLInputElement).value || '300') * 1000
                "
              />
              <p class="text-xs text-muted-foreground">
                模型未指定等待时长时的缺省值，30~900 秒（默认 300）。
              </p>
            </div>
            <div class="space-y-2">
              <Label for="behavior-budget">ReAct 工具步数预算</Label>
              <Input
                id="behavior-budget"
                v-model.number="config.toolStepBudget"
                type="number"
                min="1"
                max="12"
              />
              <p class="text-xs text-muted-foreground">
                单个 Turn 内最大工具步数（深思模式预算；默认 4）。
              </p>
            </div>
            <div class="space-y-2 sm:col-span-2">
              <Label for="behavior-nudge">wait 超时 nudge 话术</Label>
              <Textarea
                id="behavior-nudge"
                v-model="config.nudgeText"
                rows="2"
                placeholder="例：还在吗？请问还有其他问题吗？"
              />
              <p class="text-xs text-muted-foreground">
                留空 = 不代发（模型自带 nudge 优先）。配置后唤醒超时由代码直发该话术，不开模型。
              </p>
            </div>
          </div>
          <div>
            <Button type="submit" :disabled="saving">
              {{ saving ? "保存中…" : "保存行为参数" }}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
