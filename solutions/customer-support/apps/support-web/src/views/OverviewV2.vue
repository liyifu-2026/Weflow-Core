<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { contactDisplayName } from "../labels";
import WfIcon from "../components/WfIcon.vue";

type Conversation = {
  conversationId: string;
  latestMessageAt?: string;
  latestMessage?: { text?: string };
  contact?: Record<string, string>;
  handoff?: {
    status?: string;
    reason?: string;
    createdAt?: string;
    assignedUser?: { username?: string };
  } | null;
  riskLevel?: string | null;
};
type Service = {
  key: string;
  name: string;
  health: { status: string; summary: string };
  configuration: { status: string; summary: string };
};

const conversations = ref<Conversation[]>([]);
const services = ref<Service[]>([]);
const loading = ref(true);
const errors = ref<Record<string, string>>({});

const handoffs = computed(() =>
  conversations.value
    .filter((item) =>
      ["pending", "in_progress"].includes(item.handoff?.status || ""),
    )
    .sort((a, b) => {
      const risk = riskRank(b.riskLevel) - riskRank(a.riskLevel);
      if (risk) return risk;
      return (
        new Date(a.handoff?.createdAt || 0).getTime() -
        new Date(b.handoff?.createdAt || 0).getTime()
      );
    }),
);
const degradedServices = computed(() =>
  services.value.filter((service) =>
    ["degraded", "unreachable"].includes(service.health.status),
  ),
);
const actionCount = computed(
  () => handoffs.value.length + degradedServices.value.length,
);


function riskRank(risk?: string | null) {
  return risk === "high" ? 2 : risk === "medium" ? 1 : 0;
}
function riskCopy(risk?: string | null) {
  return risk === "high" ? "高风险" : risk === "medium" ? "需关注" : "常规";
}
function waitSince(value?: string) {
  if (!value) return "等待时间未知";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
  );
  return minutes < 60
    ? `等待接手 ${minutes} 分钟`
    : `等待接手 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

async function load() {
  loading.value = true;
  errors.value = {};
  const tasks: Promise<void>[] = [
    api<{ conversations: Conversation[] }>("/api/v1/conversations?limit=100")
      .then((value) => {
        conversations.value = value.conversations;
      })
      .catch((reason) => {
        errors.value.conversations =
          reason instanceof Error ? reason.message : "会话加载失败";
      }),
    api<{ services: Service[] }>("/api/v1/system/status")
      .then((value) => {
        services.value = value.services;
      })
      .catch((reason) => {
        errors.value.system =
          reason instanceof Error ? reason.message : "系统状态加载失败";
      }),
  ];
  await Promise.all(tasks);
  loading.value = false;
}
onMounted(load);
</script>

<template>
  <div class="wf-page wf-action-center">
    <header class="wf-page-head">
      <h1>运营总览</h1>
      <button class="wf-icon-button" title="刷新" @click="load">
        <WfIcon name="refresh" :size="15" />
      </button>
    </header>

    <section class="wf-action-section">
      <div class="wf-action-heading">
        <h2>需要处理</h2>
        <strong>{{ actionCount }}</strong>
      </div>
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="wf-action-row">
          <span class="wf-skeleton">正在确认待处理事项</span>
        </div>
      </template>
      <template v-else>
        <router-link
          v-for="item in handoffs"
          :key="item.conversationId"
          class="wf-action-row"
          :to="{ path: '/support/conversations', query: { id: item.conversationId } }"
        >
          <span
            class="wf-action-indicator"
            :class="{ bad: item.riskLevel === 'high' }"
          ></span>
          <div>
            <strong
              >{{ contactDisplayName(item) }} ·
              {{
                item.handoff?.reason ||
                item.latestMessage?.text ||
                "需要人工继续处理"
              }}</strong
            ><small
              >{{ riskCopy(item.riskLevel) }} ·
              {{
                waitSince(item.handoff?.createdAt || item.latestMessageAt)
              }}</small
            >
          </div>
          <span class="wf-action-link">立即处理 →</span>
        </router-link>
        <div
          v-for="service in degradedServices"
          :key="service.key"
          class="wf-action-row"
        >
          <span class="wf-action-indicator bad"></span>
          <div>
            <strong>{{ service.name }}异常</strong
            ><small>{{ service.health.summary }}</small>
          </div>
          <span class="wf-action-link">系统状态见平台控制台 →</span>
        </div>
        <div v-if="!actionCount" class="wf-current-normal">
          <strong>当前没有需要立即处理的问题。</strong>
          <p>Agent 和已监测服务运行正常。</p>
        </div>
      </template>
      <div
        v-if="errors.conversations || errors.system"
        class="wf-module-errors"
      >
        <div v-if="errors.conversations" class="wf-error">
          <span>会话：{{ errors.conversations }}</span
          ><button class="wf-button compact" @click="load">重试</button>
        </div>
        <div v-if="errors.system" class="wf-error">
          <span>系统：{{ errors.system }}</span
          ><button class="wf-button compact" @click="load">重试</button>
        </div>
      </div>
    </section>
  </div>
</template>

