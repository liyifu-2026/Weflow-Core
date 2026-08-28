<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useEscClose } from "../composables/use-esc-close";
import {
  createFAQEntry,
  createKnowledgeFromURL,
  createManualKnowledge,
  listKnowledgeTags,
  uploadKnowledgeFile,
  type KnowledgeTag,
} from "./api";

const props = defineProps<{ kbId: string; faqEnabled?: boolean }>();
const emit = defineEmits<{ close: []; done: [] }>();

// Step 1: choose a source. No inputs visible until one is chosen.
const source = ref<null | "file" | "url" | "manual" | "faq">(null);

const file = ref<File | null>(null);
const url = ref("");
const title = ref("");
const content = ref("");
const faqQuestion = ref("");
const faqAnswer = ref("");
const faqSimilar = ref("");
const submitting = ref(false);
const error = ref("");
const advancedOpen = ref(false);
useEscClose(ref(true), () => emit("close"));
const tags = ref<KnowledgeTag[]>([]);
const selectedTagIds = ref<string[]>([]);

// Per-upload overrides (defaults mirror the knowledge base settings).
const chunkStrategy = ref("auto");
const chunkSize = ref(512);
const chunkOverlap = ref(80);
const enableParentChild = ref(false);
const parentChunkSize = ref(4096);
const childChunkSize = ref(256);
const questionEnabled = ref(false);
const questionCount = ref(3);
const pdfEngine = ref("builtin");
const graphEnabled = ref(false);

function toggleTag(id: string) {
  const index = selectedTagIds.value.indexOf(id);
  if (index >= 0) selectedTagIds.value.splice(index, 1);
  else selectedTagIds.value.push(id);
}

function buildProcessConfig(): Record<string, unknown> | undefined {
  if (!advancedOpen.value) return undefined;
  const config: Record<string, unknown> = {
    chunking_config: {
      chunk_size: chunkSize.value,
      chunk_overlap: chunkOverlap.value,
      strategy: chunkStrategy.value,
      enable_parent_child: enableParentChild.value,
      parent_chunk_size: parentChunkSize.value,
      child_chunk_size: childChunkSize.value,
    },
    question_generation_config: {
      enabled: questionEnabled.value,
      question_count: questionCount.value,
    },
    graph_enabled: graphEnabled.value,
    extract_config: { enabled: graphEnabled.value },
  };
  if (pdfEngine.value === "markitdown") {
    config.parser_engine_rules = [
      { engine: "markitdown", file_types: ["pdf"] },
    ];
  }
  return config;
}

function onAdvancedToggle(event: Event) {
  advancedOpen.value = (event.target as HTMLDetailsElement).open;
}

onMounted(async () => {
  try {
    tags.value = await listKnowledgeTags(props.kbId);
  } catch {
    tags.value = [];
  }
});

async function submit() {
  if (!props.kbId || !source.value) return;
  submitting.value = true;
  error.value = "";
  try {
    if (source.value === "file") {
      if (!file.value) throw new Error("请选择文件");
      if (file.value.size > 25 * 1024 * 1024)
        throw new Error("文件不能超过 25 MB");
      await uploadKnowledgeFile(props.kbId, {
        file: file.value,
        tag_ids: selectedTagIds.value,
        process_config: buildProcessConfig(),
      });
    } else if (source.value === "url") {
      if (!url.value.trim()) throw new Error("请输入 URL");
      await createKnowledgeFromURL(props.kbId, {
        url: url.value.trim(),
        tag_ids: selectedTagIds.value,
      });
    } else if (source.value === "manual") {
      if (!title.value.trim() || !content.value.trim())
        throw new Error("请填写标题和内容");
      await createManualKnowledge(props.kbId, {
        title: title.value.trim(),
        content: content.value,
        tag_ids: selectedTagIds.value,
      });
    } else {
      if (!faqQuestion.value.trim() || !faqAnswer.value.trim())
        throw new Error("请填写问题和答案");
      await createFAQEntry(props.kbId, {
        question: faqQuestion.value.trim(),
        answer: faqAnswer.value,
        similar_questions: faqSimilar.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
    }
    emit("done");
    emit("close");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "添加失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="wf-modal-mask" @click.self="emit('close')">
    <div class="wf-modal wf-modal-upload">
      <div class="wf-modal-head">
        <h3>添加知识</h3>
        <button class="wf-icon-button" @click="emit('close')">×</button>
      </div>
      <div class="wf-modal-body">
        <template v-if="!source">
          <p class="wf-muted wf-upload-hint">选择内容来源</p>
          <div class="wf-source-grid">
            <button class="wf-source-card" @click="source = 'file'">
              <strong>上传文件</strong>
              <span class="wf-muted">PDF、Word、PPT 等</span>
            </button>
            <button class="wf-source-card" @click="source = 'url'">
              <strong>添加网页</strong>
              <span class="wf-muted">按 URL 抓取内容</span>
            </button>
            <button class="wf-source-card" @click="source = 'manual'">
              <strong>输入文本</strong>
              <span class="wf-muted">直接粘贴在线内容</span>
            </button>
            <button
              v-if="faqEnabled"
              class="wf-source-card"
              @click="source = 'faq'"
            >
              <strong>添加 FAQ</strong>
              <span class="wf-muted">标准问题与答案</span>
            </button>
          </div>
        </template>

        <template v-else>
          <button class="wf-link wf-link-button wf-upload-back" @click="source = null">
            ← 更换来源
          </button>
          <div v-if="error" class="wf-error">{{ error }}</div>
          <div v-if="tags.length" class="wf-field">
            <label>标签</label>
            <div class="wf-tag-picker">
              <button
                v-for="tag in tags"
                :key="tag.id"
                type="button"
                class="wf-tag-chip"
                :class="{ active: selectedTagIds.includes(tag.id) }"
                @click="toggleTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
          </div>

          <template v-if="source === 'file'">
            <div class="wf-field">
              <label>文件（最大 25 MB）</label>
              <input
                class="wf-input"
                type="file"
                @change="
                  file = ($event.target as HTMLInputElement).files?.[0] || null
                "
              />
            </div>
            <p class="wf-muted">
              上传后进入解析队列；达到可用状态后才参与 Agent 检索。
            </p>
            <details
              class="wf-upload-advanced"
              :open="advancedOpen"
              @toggle="onAdvancedToggle"
            >
              <summary>高级设置 ></summary>
              <div class="wf-advanced-body">
                <div class="wf-grid">
                  <div class="wf-field wf-span-4">
                    <label>分块策略</label>
                    <select v-model="chunkStrategy" class="wf-select">
                      <option value="auto">自动</option>
                      <option value="heading">按标题</option>
                      <option value="heuristic">启发式</option>
                    </select>
                  </div>
                  <div class="wf-field wf-span-4">
                    <label>块大小</label>
                    <input v-model.number="chunkSize" type="number" min="64" class="wf-input" />
                  </div>
                  <div class="wf-field wf-span-4">
                    <label>重叠</label>
                    <input v-model.number="chunkOverlap" type="number" min="0" class="wf-input" />
                  </div>
                </div>
                <label class="wf-checkbox-row">
                  <input v-model="enableParentChild" type="checkbox" />Parent-child
                  父子分块
                </label>
                <div v-if="enableParentChild" class="wf-grid">
                  <div class="wf-field wf-span-6">
                    <label>父块大小</label>
                    <input v-model.number="parentChunkSize" type="number" min="256" class="wf-input" />
                  </div>
                  <div class="wf-field wf-span-6">
                    <label>子块大小</label>
                    <input v-model.number="childChunkSize" type="number" min="64" class="wf-input" />
                  </div>
                </div>
                <div class="wf-grid">
                  <div class="wf-field wf-span-4">
                    <label>PDF 解析引擎</label>
                    <select v-model="pdfEngine" class="wf-select">
                      <option value="builtin">内置</option>
                      <option value="markitdown">MarkItDown</option>
                    </select>
                  </div>
                  <div class="wf-field wf-span-8">
                    <label>问题生成</label>
                    <div class="wf-advanced-inline">
                      <label class="wf-checkbox-row">
                        <input v-model="questionEnabled" type="checkbox" />启用
                      </label>
                      <input
                        v-if="questionEnabled"
                        v-model.number="questionCount"
                        type="number"
                        min="1"
                        max="10"
                        class="wf-input wf-question-count"
                      />
                    </div>
                  </div>
                </div>
                <label class="wf-checkbox-row">
                  <input v-model="graphEnabled" type="checkbox" />提取实体关系
                  （Graph）
                </label>
              </div>
            </details>
          </template>

          <template v-else-if="source === 'url'">
            <div class="wf-field">
              <label>网页地址</label>
              <input v-model="url" class="wf-input" placeholder="https://…" />
            </div>
          </template>

          <template v-else-if="source === 'manual'">
            <div class="wf-field">
              <label>标题</label>
              <input v-model="title" class="wf-input" />
            </div>
            <div class="wf-field">
              <label>内容</label>
              <textarea v-model="content" class="wf-textarea" rows="8"></textarea>
            </div>
          </template>

          <template v-else>
            <div class="wf-field">
              <label>标准问题</label>
              <input v-model="faqQuestion" class="wf-input" />
            </div>
            <div class="wf-field">
              <label>答案</label>
              <textarea v-model="faqAnswer" class="wf-textarea" rows="4"></textarea>
            </div>
            <div class="wf-field">
              <label>相似问题（每行一条）</label>
              <textarea
                v-model="faqSimilar"
                class="wf-textarea"
                rows="3"
                placeholder="客户可能换一种问法…"
              ></textarea>
            </div>
          </template>
        </template>
      </div>
      <div class="wf-modal-foot">
        <button class="wf-button" @click="emit('close')">取消</button>
        <button
          v-if="source"
          class="wf-button primary"
          :disabled="submitting"
          @click="submit"
        >
          {{ submitting ? "提交中" : "开始导入" }}
        </button>
      </div>
    </div>
  </div>
</template>

