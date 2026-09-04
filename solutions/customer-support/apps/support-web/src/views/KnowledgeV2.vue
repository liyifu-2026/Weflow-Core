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
import { ArrowRight, Search } from "lucide-vue-next";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

function scoreBadgeVariant(percent: number): "secondary" | "outline" | "destructive" {
  if (percent > 80) return "secondary";
  if (percent >= 50) return "outline";
  return "destructive";
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
  <div class="flex flex-col gap-6 p-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-semibold tracking-tight">知识</h1>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="mode = 'content'">浏览知识</Button>
        <Button variant="outline" size="sm" as-child>
          <a :href="manageHref" target="_blank" rel="noopener">管理知识库</a>
        </Button>
      </div>
    </header>

    <div
      class="inline-flex w-fit rounded-md border border-border bg-muted p-0.5"
      role="tablist"
      aria-label="知识工作模式"
    >
      <button
        v-for="item in MODES"
        :key="item.key"
        class="rounded-[5px] px-3 py-1.5 text-sm transition-colors"
        :class="
          mode === item.key
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        "
        role="tab"
        :aria-selected="mode === item.key"
        @click="mode = item.key"
      >
        {{ item.label }}
      </button>
    </div>

    <template v-if="mode === 'validate'">
      <section class="flex flex-col gap-3">
        <div class="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
          <Search class="size-4 shrink-0 text-muted-foreground" />
          <input
            v-model="question"
            class="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="输入一个真实客户问题…"
            @keyup.enter="searchEvidence"
          />
          <Button :disabled="searching || !question.trim()" @click="searchEvidence">
            {{ searching ? "验证中" : "验证回答" }}
          </Button>
        </div>
        <div v-if="origin.type !== 'standalone'" class="flex items-center justify-between text-sm text-muted-foreground">
          <span>来自客户的当前会话</span>
          <Button variant="link" size="sm" class="h-auto p-0" @click="returnToOrigin(router, origin)">
            返回 <ArrowRight class="size-3.5" />
          </Button>
        </div>
      </section>

      <Alert v-if="error" variant="destructive" class="items-center">
        <AlertDescription class="flex items-center justify-between gap-3">
          <span>{{ error }}</span>
          <Button variant="outline" size="sm" @click="searchEvidence">重试</Button>
        </AlertDescription>
      </Alert>

      <!-- 未发起验证时的空态兜底（避免大片空白） -->
      <div
        v-if="!searching && !searched && !error"
        class="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border py-16 text-center"
      >
        <Search class="size-6 text-muted-foreground/60" />
        <p class="text-sm font-medium">输入客户问题开始验证</p>
        <p class="max-w-sm text-xs text-muted-foreground">
          系统将检索知识库并返回可引用的回答依据，用于核对 Agent 回答是否有出处。
        </p>
      </div>

      <section v-if="searching || result || searched" class="flex flex-col gap-3">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">回答依据</p>
          <h2 v-if="result?.evidence.length" class="mt-1 text-lg font-semibold tracking-tight">
            找到 {{ result.evidence.length }} 条依据
          </h2>
          <h2 v-else-if="searched" class="mt-1 text-lg font-semibold tracking-tight">当前没有可靠依据</h2>
        </div>

        <template v-if="searching">
          <div v-for="i in 3" :key="i" class="space-y-2 rounded-md border border-border p-4">
            <Skeleton class="h-4 w-40" />
            <Skeleton class="h-3 w-full" />
          </div>
        </template>

        <button
          v-for="item in result?.evidence || []"
          v-else
          :key="item.evidenceId"
          class="w-full rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
          @click="openEvidence(item)"
        >
          <div class="flex w-full items-center justify-between gap-2">
            <strong class="text-sm">{{ item.title || "知识来源" }}</strong>
            <span
              v-if="evidenceScorePercent(item) !== null"
              class="shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium"
              :class="
                evidenceScorePercent(item)! > 80
                  ? 'border-transparent bg-secondary text-secondary-foreground'
                  : evidenceScorePercent(item)! >= 50
                    ? 'border-border text-foreground'
                    : 'border-transparent bg-destructive text-white'
              "
            >{{ evidenceScorePercent(item) }} 分</span>
          </div>
          <div class="mt-1 text-xs text-muted-foreground">
            <template v-if="kbName(item)">{{ kbName(item) }} · </template>
            {{ item.sourceType || "内容" }}
          </div>
          <div class="mt-2 text-sm leading-relaxed">
            <template v-if="item.excerpt">
              <template
                v-for="(segment, index) in splitHighlight(item.excerpt, question)"
                :key="index"
              >
                <mark v-if="segment.hit" class="rounded-sm bg-muted px-0.5 text-foreground">{{
                  segment.text
                }}</mark>
                <template v-else>{{ segment.text }}</template>
              </template>
            </template>
            <template v-else>—</template>
          </div>
          <span class="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            定位来源 <ArrowRight class="size-3" />
          </span>
        </button>

        <div
          v-if="searched && !searching && !result?.evidence.length"
          class="rounded-md border border-dashed border-border p-6 text-center"
        >
          <p class="text-sm font-medium">这里缺少可靠依据</p>
          <p class="mt-1 text-sm text-muted-foreground">当前知识无法回答这个问题。请联系管理员补充可靠内容。</p>
        </div>
      </section>
    </template>

    <KnowledgeContent v-else-if="mode === 'content'" :origin="origin" />
  </div>
</template>
