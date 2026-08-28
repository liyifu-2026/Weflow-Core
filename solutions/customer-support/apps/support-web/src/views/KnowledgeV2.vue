<script setup lang="ts">
/**
 * 知识工作区（只读）：
 * - validate：从会话/策略/独立入口进入的"问题 → 证据"验证流，调用 Core knowledge 路由
 * - content：浏览知识库与文档，纯只读；管理动作统一在外部知识库原生界面
 *
 * 平台约束：
 * - 知识展示数据源走 Core knowledge 路由（/api/v1/knowledge/*），不直连 WeKnora
 * - 跳转外部知识库管理界面用 /api/v1/knora/redirect（同源跳转 → 跨源 bridge.html）
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
import { searchKnowledge, listKnowledgeBases } from "../knowledge/api";
import {
  evidenceScorePercent,
  normalizeKnowledgeEvidence,
  type WeflowEvidence,
} from "../knowledge/evidence-normalizer";
import { splitHighlight } from "../knowledge/highlight";
import { recordValidateSearch } from "../knowledge/search-stats";
import KnowledgeContent from "../knowledge/KnowledgeContent.vue";
import { parseOrigin, returnToOrigin, knowledgeTarget } from "../navigation-context";
import { useKnowledgeWorkspaceStore } from "../stores/knowledge-workspace";
import { useNavigationContextStore } from "../stores/navigation-context";

type KnowledgeMode = "validate" | "content";

const MODES: Array<{ key: KnowledgeMode; label: string }> = [
  { key: "validate", label: "验证" },
  { key: "content", label: "内容" },
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

const mode = computed<KnowledgeMode>({
  get: () => {
    const raw = route.query.mode;
    if (typeof raw === "string" && MODES.some((item) => item.key === raw)) {
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

// 证据来源展示需要知识库名；进入页面时拉取一次 id → name 映射。
const kbNames = ref<Map<string, string>>(new Map());
void listKnowledgeBases()
  .then((bases) => {
    kbNames.value = new Map(bases.map((item) => [item.id, item.name]));
  })
  .catch(() => {
    // 映射不可用时退化为只显示文档标题。
  });

function kbName(evidence: WeflowEvidence): string {
  return evidence.knowledgeBaseId
    ? (kbNames.value.get(evidence.knowledgeBaseId) ?? "")
    : "";
}

function scoreTier(percent: number): string {
  if (percent > 80) return "high";
  if (percent >= 50) return "mid";
  return "low";
}

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
    recordValidateSearch();
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

/** 跳转到外部知识库管理界面（Core 代管登录 → bridge.html → 知识库 UI） */
const manageHref = computed(() => {
  const params = new URLSearchParams();
  const target =
    typeof route.query.kb === "string" && route.query.kb
      ? `/platform/knowledge-bases/${encodeURIComponent(route.query.kb)}`
      : "/";
  params.set("target", target);
  return `/api/v1/knora/redirect?${params.toString()}`;
});

watch(origin, (value) => navigation.setOrigin(value), { immediate: true });
onMounted(() => {
  // 从会话/策略带入的验证：进入验证模式且已带问题 → 自动验证
  if (mode.value === "validate" && question.value.trim()) {
    void searchEvidence();
  }
});
</script>

<template>
  <div class="wf-page wf-page-wide">
    <header class="wf-page-head">
      <h1>知识</h1>
      <div class="wf-actions">
        <button class="wf-button" @click="mode = 'content'">浏览知识</button>
        <a
          class="wf-button"
          :href="manageHref"
          target="_blank"
          rel="noopener"
        >
          管理知识库
        </a>
      </div>
    </header>

    <div class="wf-knowledge-modes" role="tablist" aria-label="知识工作模式">
      <button
        v-for="item in MODES"
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

    <template v-if="mode === 'validate'">
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
          <span>来自客户的当前会话</span>
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
          <div class="wf-evidence-head">
            <strong>{{ item.title || "知识来源" }}</strong>
            <span
              v-if="evidenceScorePercent(item) !== null"
              class="wf-score-badge"
              :class="scoreTier(evidenceScorePercent(item)!)"
              >{{ evidenceScorePercent(item) }} 分</span
            >
          </div>
          <div class="wf-subtle wf-evidence-meta">
            <template v-if="kbName(item)">{{ kbName(item) }} · </template>
            {{ item.sourceType || "内容" }}
          </div>
          <div class="wf-evidence-content">
            <template v-if="item.excerpt">
              <template
                v-for="(segment, index) in splitHighlight(item.excerpt, question)"
                :key="index"
              >
                <mark v-if="segment.hit" class="wf-highlight">{{
                  segment.text
                }}</mark>
                <template v-else>{{ segment.text }}</template>
              </template>
            </template>
            <template v-else>—</template>
          </div>
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
  </div>
</template>

<style scoped>
.wf-evidence-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}
.wf-evidence-meta {
  margin-top: 2px;
}
.wf-score-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
}
.wf-score-badge.high {
  background: #e6f4ea;
  color: #137333;
}
.wf-score-badge.mid {
  background: #fef7e0;
  color: #b06000;
}
.wf-score-badge.low {
  background: #fce8e6;
  color: #c5221f;
}
.wf-highlight {
  background: #fde293;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
