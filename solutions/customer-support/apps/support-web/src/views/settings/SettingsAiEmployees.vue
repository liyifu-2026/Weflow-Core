<script setup lang="ts">
const emit = defineEmits<{ saved: [] }>();

/**
 * 设置中心 · ① AI员工分区：员工管理入口 + 预判分流（Triage）+ 行为参数。
 * 行为参数（R2）：会话 TTL/轮数上限/wait 上限/nudge 话术/ReAct 预算，
 * 存扩展设置 behavior 键，agent-worker 30s TTL 缓存热读，无需重启。
 * Triage 开关存扩展设置 pipeline.triage.enabled。
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  readPipelineSettings,
  writePipelineSettingsSection,
} from "./common";

const router = useRouter();

type BehaviorConfig = {
  sessionTtlMinutes: number;
  sessionRoundBudget: number;
  defaultWaitMs: number;
  nudgeText: string;
  handoffReminderText: string;
  handoffReminderDelayMs: number;
  toolStepBudget: number;
};

const DEFAULTS: BehaviorConfig = {
  sessionTtlMinutes: 45,
  sessionRoundBudget: 24,
  defaultWaitMs: 300_000,
  nudgeText: "",
  handoffReminderText: "",
  handoffReminderDelayMs: 120_000,
  toolStepBudget: 4,
};

const config = ref<BehaviorConfig>({ ...DEFAULTS });
const rawSettings = ref<Record<string, unknown>>({});
const loading = ref(true);
const saving = ref(false);
const notice = ref("");
const error = ref("");

// 预判分流（Triage）：存 pipeline.triage.enabled（默认 false）。
// triageRaw 保留 triage 节内 UI 未暴露的其他键，保存时原样带回。
const triageEnabled = ref(false);
const triageRaw = ref<Record<string, unknown>>({});

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
    handoffReminderText:
      typeof source.handoffReminderText === "string"
        ? source.handoffReminderText
        : DEFAULTS.handoffReminderText,
    handoffReminderDelayMs: num(
      source.handoffReminderDelayMs,
      DEFAULTS.handoffReminderDelayMs,
    ),
    toolStepBudget: num(source.toolStepBudget, DEFAULTS.toolStepBudget),
  };
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    rawSettings.value = await readPipelineSettings();
    applyBehavior(rawSettings.value.behavior);
    const pipeline =
      typeof rawSettings.value.pipeline === "object" &&
      rawSettings.value.pipeline !== null
        ? (rawSettings.value.pipeline as Record<string, unknown>)
        : {};
    const triage =
      typeof pipeline.triage === "object" && pipeline.triage !== null
        ? (pipeline.triage as Record<string, unknown>)
        : {};
    triageRaw.value = triage;
    triageEnabled.value = triage.enabled === true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "行为参数加载失败";
  } finally {
    loading.value = false;
  }
}

/** 按输入框 min/max 钳制数值：越界值钳到边界，避免后端静默回落出厂默认 */
function clampNum(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  notice.value = "";
  error.value = "";
  try {
    // 数值字段按各自输入框的 min/max 钳制后再保存。
    const clamped: BehaviorConfig = {
      sessionTtlMinutes: Math.round(
        clampNum(config.value.sessionTtlMinutes, 5, 1440, DEFAULTS.sessionTtlMinutes),
      ),
      sessionRoundBudget: Math.round(
        clampNum(
          config.value.sessionRoundBudget,
          1,
          200,
          DEFAULTS.sessionRoundBudget,
        ),
      ),
      defaultWaitMs: clampNum(
        config.value.defaultWaitMs,
        30_000,
        900_000,
        DEFAULTS.defaultWaitMs,
      ),
      handoffReminderDelayMs: clampNum(
        config.value.handoffReminderDelayMs,
        30_000,
        1_800_000,
        DEFAULTS.handoffReminderDelayMs,
      ),
      toolStepBudget: Math.round(
        clampNum(config.value.toolStepBudget, 1, 12, DEFAULTS.toolStepBudget),
      ),
      nudgeText: config.value.nudgeText,
      handoffReminderText: config.value.handoffReminderText,
    };
    // Triage 先写 pipeline 节（浅合并保留 triage 内其他键），再写 behavior 节；
    // 两次写入各自重读整行，互不覆盖。
    await writePipelineSettingsSection("pipeline", {
      triage: { ...triageRaw.value, enabled: triageEnabled.value },
    });
    // 保存前重读整行再合并，避免覆盖其他分区刚保存的内容。
    await writePipelineSettingsSection("behavior", { ...clamped });
    config.value = clamped;
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
          <!-- 预判分流（Triage）：存 pipeline.triage.enabled，随下方保存按钮一并写入 -->
          <div class="flex items-start justify-between gap-4 rounded-md border border-border p-4">
            <div class="min-w-0 space-y-1">
              <Label for="triage-enabled">预判分流（Triage）</Label>
              <p class="text-xs text-muted-foreground">
                开启后每次 AI 回复前先用极速小模型预判（人工/自动、简单/标准）；
                需在「模型」分区绑定 triage 槽位。关闭时不做预判。
              </p>
            </div>
            <Switch
              id="triage-enabled"
              v-model="triageEnabled"
              class="mt-1 shrink-0"
            />
          </div>
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
            <div class="space-y-2 sm:col-span-2">
              <Label for="behavior-handoff-reminder">转人工兜底提醒话术</Label>
              <Textarea
                id="behavior-handoff-reminder"
                v-model="config.handoffReminderText"
                rows="2"
                placeholder="例：已帮你转人工客服了，稍等一下哈。"
              />
              <p class="text-xs text-muted-foreground">
                留空 = 关闭。转人工后长时间无人认领时，系统代发这条轻提示，避免客户干等。
              </p>
            </div>
            <div class="space-y-2">
              <Label for="behavior-handoff-reminder-delay">转人工提醒延迟（秒）</Label>
              <Input
                id="behavior-handoff-reminder-delay"
                :value="Math.round(config.handoffReminderDelayMs / 1000)"
                type="number"
                min="30"
                max="1800"
                @input="
                  config.handoffReminderDelayMs =
                    Number(($event.target as HTMLInputElement).value || '120') * 1000
                "
              />
              <p class="text-xs text-muted-foreground">
                转人工后无人认领多久发提醒，30~1800 秒（默认 120）。
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
