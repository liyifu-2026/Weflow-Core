<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
import { searchKnowledge } from "../knowledge/api";
import { normalizeKnowledgeEvidence, type WeflowEvidence } from "../knowledge/evidence-normalizer";
import KnowledgeContent from "../knowledge/KnowledgeContent.vue";
import KnowledgeConfig from "../knowledge/KnowledgeConfig.vue";
import KnowledgeDatasources from "../knowledge/KnowledgeDatasources.vue";
import { parseOrigin, returnToOrigin, knowledgeTarget } from "../navigation-context";
import { useKnowledgeWorkspaceStore } from "../stores/knowledge-workspace";
import { useNavigationContextStore } from "../stores/navigation-context";

type KnowledgeMode =
  | "validate"
  | "content"
  | "datasource"
  | "config"
  | "platform";

const MODES: Array<{ key: KnowledgeMode; label: string; adminOnly?: boolean }> = [
  { key: "validate", label: "验证" },
  { key: "content", label: "内容" },
  { key: "platform", label: "平台管理" },
  { key: "datasource", label: "数据源", adminOnly: true },
  { key: "config", label: "配置", adminOnly: true },
];

type SearchResult = {
  searchId: string;
  status: string;
  evidence: WeflowEvidence[];
};

const auth = useWeflowAuthStore();
const route = useRoute();
const router = useRouter();
const navigation = useNavigationContextStore();
const origin = computed(() => parseOrigin(route.query));
const contextKey = computed(() => {
  const value = origin.value;
  return value.type === "conversation"
    ? `${auth.user?.userId}:conversation:${value.conversationId}`
    : value.type === "strategy"
      ? `${auth.user?.userId}:strategy:${value.policyVersionId}`
      : `${auth.user?.userId}:standalone`;
});
const workspaceStore = useKnowledgeWorkspaceStore();

const question = computed({
  get: () => workspaceStore.open(contextKey.value).question,
  set: (value: string) => {
    workspaceStore.open(contextKey.value).question = value;
  },
});
const selectedId = computed({
  get: () => workspaceStore.open(contextKey.value).selectedKnowledgeBaseId,
  set: (value: string) => {
    workspaceStore.open(contextKey.value).selectedKnowledgeBaseId = value;
  },
});

const visibleModes = computed(() =>
  MODES.filter((item) => !item.adminOnly || auth.isAdmin),
);
const mode = computed<KnowledgeMode>({
  get: () => {
    const raw = route.query.mode;
    if (
      typeof raw === "string" &&
      MODES.some((item) => item.key === raw)
    ) {
      // 客户端守卫：adminOnly 模式对 operator 强制回验证页
      // （与服务端拦截一致，避免手输 URL 直达配置页）。
      const item = MODES.find((entry) => entry.key === raw);
      if (item?.adminOnly && !auth.isAdmin) return "validate";
      return raw as KnowledgeMode;
    }
    return "validate";
  },
  set: (value: KnowledgeMode) => {
    void router.replace({ query: { ...route.query, mode: value } });
  },
});

const result = ref<SearchResult | null>(null);
const searching = ref(false);
const searched = ref(false);
const error = ref("");

async function searchEvidence() {
  if (!question.value.trim()) return;
  searching.value = true;
  error.value = "";
  try {
    let knowledgeBaseIds: string[] | undefined;
    if (selectedId.value) {
      knowledgeBaseIds = [selectedId.value];
    } else {
      // knowledge-search requires at least one KB scope; fall back to all
      // KBs visible to the current user.
      const scopes = await api<{ scopes: Array<{ id: string }> }>(
        "/api/v1/knowledge/scopes",
      );
      knowledgeBaseIds = scopes.scopes.map((scope) => scope.id);
    }
    const payload = await searchKnowledge({
      query: question.value.trim(),
      knowledgeBaseIds,
    });
    result.value = {
      searchId: String((payload as Record<string, unknown>)?.searchId ?? ""),
      status: "completed",
      evidence: normalizeKnowledgeEvidence(payload),
    };
    searched.value = true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "知识验证失败";
  } finally {
    searching.value = false;
  }
}

function openEvidence(item: WeflowEvidence) {
  if (item.knowledgeBaseId) selectedId.value = item.knowledgeBaseId;
  void router.push(
    knowledgeTarget(
      origin.value,
      {
        knowledgeBaseId: item.knowledgeBaseId,
        documentId: item.documentId,
        chunkId: item.chunkId,
        evidenceId: item.evidenceId,
      },
    ),
  );
}

watch(origin, (value) => navigation.setOrigin(value), { immediate: true });
onMounted(() => {
  // 从会话/策略带入的验证：进入验证模式且已带问题 → 自动验证
  if (mode.value === "validate" && question.value.trim()) {
    void searchEvidence();
  }
  if (mode.value === "platform") {
    void launchPlatform();
  }
});

// ---------- WeKnora 平台管理（iframe 内嵌 + 一次性 code 免密登录） ----------
// 本机默认 http://localhost（WeKnora UI :80）；公网接线后构建时设 VITE_KNORA_ORIGIN=https://kb.leaif.com
const KNORA_ORIGIN = (import.meta.env.VITE_KNORA_ORIGIN || "http://localhost").replace(/\/$/, "");
const platformBridgeSrc = ref("");
const platformError = ref("");
const platformPreparing = ref(false);
const bootstrapNeeded = ref(false);
const bootstrapEmail = ref("");
const bootstrapPassword = ref("");
const bootstrapBusy = ref(false);
const bootstrapError = ref("");

function platformTarget(): string {
  const kb = route.query.kb;
  return typeof kb === "string" && kb
    ? `/platform/knowledge-bases/${encodeURIComponent(kb)}`
    : "/platform/knowledge-bases";
}

function bridgeUrl(code: string): string {
  const target = platformTarget();
  const query = new URLSearchParams({
    code,
    target,
    api: window.location.origin,
  });
  return `${KNORA_ORIGIN}/bridge.html?${query.toString()}`;
}

/** 换取一次性 code 并加载桥接 iframe；WeKnora 账号已存在时引导一次性绑定 */
async function launchPlatform() {
  platformPreparing.value = true;
  platformError.value = "";
  bootstrapNeeded.value = false;
  try {
    const response = await fetch("/api/v1/knora/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      credentials: "include",
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        email?: string;
      };
      bootstrapEmail.value = body.email || "";
      bootstrapNeeded.value = true;
      return;
    }
    if (!response.ok) {
      platformError.value = "无法打开 WeKnora 管理界面，请稍后重试";
      return;
    }
    const body = (await response.json()) as { code?: string };
    if (!body.code) {
      platformError.value = "无法打开 WeKnora 管理界面，请稍后重试";
      return;
    }
    platformBridgeSrc.value = bridgeUrl(body.code);
  } catch {
    platformError.value = "无法打开 WeKnora 管理界面，请稍后重试";
  } finally {
    platformPreparing.value = false;
  }
}

async function submitBootstrap() {
  if (!bootstrapPassword.value || bootstrapBusy.value) return;
  bootstrapBusy.value = true;
  bootstrapError.value = "";
  try {
    const response = await fetch("/api/v1/knora/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: bootstrapPassword.value }),
      credentials: "include",
    });
    if (!response.ok) {
      bootstrapError.value =
        response.status === 401
          ? "密码不正确，请重试"
          : "绑定失败，请稍后重试";
      return;
    }
    bootstrapPassword.value = "";
    await launchPlatform();
  } catch {
    bootstrapError.value = "绑定失败，请稍后重试";
  } finally {
    bootstrapBusy.value = false;
  }
}

function openPlatformNewWindow() {
  if (!platformBridgeSrc.value) return;
  window.open(platformBridgeSrc.value, "_blank", "noopener");
}

/** bridge 页跨源消息：WeKnora 账号已存在 → 引导一次性绑定 */
function onBridgeMessage(event: MessageEvent) {
  if (
    !event.origin ||
    (event.origin !== KNORA_ORIGIN && !KNORA_ORIGIN.startsWith("http://localhost"))
  ) {
    return;
  }
  const data = event.data as { type?: string; email?: string } | null;
  if (data?.type === "weflow:knora-bootstrap-required") {
    bootstrapEmail.value = data.email || "";
    bootstrapNeeded.value = true;
  }
}

onMounted(() => window.addEventListener("message", onBridgeMessage));
onUnmounted(() => window.removeEventListener("message", onBridgeMessage));
</script>

<template>
  <div class="wf-page wf-page-wide">
    <header class="wf-page-head">
      <h1>知识</h1>
      <div class="wf-actions">
        <button class="wf-button" @click="mode = 'content'">浏览知识</button>
      </div>
    </header>

    <div class="wf-knowledge-modes" role="tablist" aria-label="知识工作模式">
      <button
        v-for="item in visibleModes"
        :key="item.key"
        class="wf-knowledge-mode"
        :class="{ active: mode === item.key }"
        role="tab"
        :aria-selected="mode === item.key"
        @click="mode = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <template v-if="mode === 'platform'">
      <section class="wf-platform-pane">
        <div class="wf-platform-bar">
          <div>
            <span class="wf-eyebrow">WeKnora 平台管理</span>
            <span class="wf-subtle">免密直连知识库管理界面（账号由 Weflow 代管）</span>
          </div>
          <div class="wf-actions">
            <button
              class="wf-button compact"
              :disabled="platformPreparing"
              @click="launchPlatform"
            >
              刷新登录
            </button>
            <button
              class="wf-button compact"
              :disabled="!platformBridgeSrc"
              @click="openPlatformNewWindow"
            >
              新窗口打开
            </button>
            <button class="wf-button compact" @click="mode = 'content'">
              关闭
            </button>
          </div>
        </div>

        <div v-if="bootstrapNeeded" class="wf-platform-bootstrap">
          <span>
            WeKnora 账号 <strong>{{ bootstrapEmail || "…" }}</strong>
            已存在，输入一次它的登录密码完成绑定（仅本次，之后自动登录）：
          </span>
          <input
            v-model="bootstrapPassword"
            type="password"
            class="wf-input"
            placeholder="WeKnora 登录密码"
            @keyup.enter="submitBootstrap"
          />
          <button
            class="wf-button primary compact"
            :disabled="bootstrapBusy || !bootstrapPassword"
            @click="submitBootstrap"
          >
            {{ bootstrapBusy ? "绑定中" : "绑定" }}
          </button>
          <span v-if="bootstrapError" class="wf-risk-text high">{{
            bootstrapError
          }}</span>
        </div>

        <div v-if="platformError" class="wf-error">
          <span>{{ platformError }}</span>
          <button class="wf-button compact" @click="launchPlatform">重试</button>
        </div>

        <div class="wf-platform-frame">
          <iframe
            v-if="platformBridgeSrc"
            :src="platformBridgeSrc"
            title="WeKnora 平台管理"
            referrerpolicy="no-referrer"
            @load="platformError = ''"
          ></iframe>
          <div v-else class="wf-platform-empty">
            <span class="wf-skeleton">正在准备 WeKnora 管理界面</span>
          </div>
        </div>
      </section>
    </template>

    <template v-else-if="mode === 'validate'">
      <section class="wf-question-workspace">
        <div class="wf-question-input">
          <WfIcon name="search" :size="18" />
          <input
            v-model="question"
            class="wf-input"
            placeholder="输入一个真实客户问题…"
            @keyup.enter="searchEvidence"
          />
          <button
            class="wf-button primary"
            :disabled="searching || !question.trim()"
            @click="searchEvidence"
          >
            {{ searching ? "验证中" : "验证回答" }}
          </button>
        </div>
        <div v-if="origin.type !== 'standalone'" class="wf-origin-strip">
          <span>{{
            origin.type === "conversation"
              ? "来自客户的当前会话"
              : "来自策略验证"
          }}</span>
          <button class="wf-link wf-link-button" @click="returnToOrigin(router, origin)">
            返回 →
          </button>
        </div>
      </section>

      <div v-if="error" class="wf-error">
        <span>{{ error }}</span>
        <button class="wf-button compact" @click="searchEvidence">重试</button>
      </div>

      <section v-if="searching || result || searched" class="wf-answer-section">
        <div class="wf-section-heading">
          <div>
            <span class="wf-eyebrow">回答依据</span>
            <h2 v-if="result?.evidence.length">
              找到 {{ result.evidence.length }} 条依据
            </h2>
            <h2 v-else-if="searched">当前没有可靠依据</h2>
          </div>
        </div>
        <template v-if="searching">
          <div v-for="i in 3" :key="i" class="wf-evidence-result">
            <span class="wf-skeleton">正在读取来源</span>
            <span class="wf-skeleton">正在读取命中切片</span>
          </div>
        </template>
        <button
          v-for="item in result?.evidence || []"
          v-else
          :key="item.evidenceId"
          class="wf-evidence-result wf-evidence-button"
          @click="openEvidence(item)"
        >
          <div>
            <strong>{{ item.title || "知识来源" }}</strong>
            <div class="wf-subtle">{{ item.sourceType || "内容" }}</div>
          </div>
          <div class="wf-evidence-content">{{ item.excerpt || "—" }}</div>
          <span class="wf-link">定位来源 →</span>
        </button>
        <div
          v-if="searched && !searching && !result?.evidence.length"
          class="wf-knowledge-gap"
        >
          <strong>这里缺少可靠依据</strong>
          <p>当前知识无法回答这个问题。请联系管理员补充可靠内容。</p>
        </div>
      </section>
    </template>

    <KnowledgeContent v-else-if="mode === 'content'" :origin="origin" />
    <KnowledgeDatasources v-else-if="mode === 'datasource'" />
    <KnowledgeConfig v-else-if="mode === 'config'" />
  </div>
</template>
