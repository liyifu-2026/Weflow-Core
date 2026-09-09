<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useEscClose } from "../composables/use-esc-close";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  <Dialog :open="true" @update:open="(value) => !value && emit('close')">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>添加知识</DialogTitle>
      </DialogHeader>

      <template v-if="!source">
        <p class="text-sm text-muted-foreground">选择内容来源</p>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            class="rounded-md border border-border p-4 text-left transition-colors hover:bg-muted/50"
            @click="source = 'file'"
          >
            <strong class="block text-sm">上传文件</strong>
            <span class="text-xs text-muted-foreground">PDF、Word、PPT 等</span>
          </button>
          <button
            class="rounded-md border border-border p-4 text-left transition-colors hover:bg-muted/50"
            @click="source = 'url'"
          >
            <strong class="block text-sm">添加网页</strong>
            <span class="text-xs text-muted-foreground">按 URL 抓取内容</span>
          </button>
          <button
            class="rounded-md border border-border p-4 text-left transition-colors hover:bg-muted/50"
            @click="source = 'manual'"
          >
            <strong class="block text-sm">输入文本</strong>
            <span class="text-xs text-muted-foreground">直接粘贴在线内容</span>
          </button>
          <button
            v-if="faqEnabled"
            class="rounded-md border border-border p-4 text-left transition-colors hover:bg-muted/50"
            @click="source = 'faq'"
          >
            <strong class="block text-sm">添加 FAQ</strong>
            <span class="text-xs text-muted-foreground">标准问题与答案</span>
          </button>
        </div>
      </template>

      <template v-else>
        <div class="space-y-4">
          <Button variant="link" size="sm" class="h-auto p-0" @click="source = null">
            ← 更换来源
          </Button>

          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>

          <div v-if="tags.length" class="space-y-2">
            <Label>标签</Label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="tag in tags"
                :key="tag.id"
                type="button"
                class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
                :class="
                  selectedTagIds.includes(tag.id)
                    ? 'border-transparent bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                "
                @click="toggleTag(tag.id)"
              >
                {{ tag.name }}
              </button>
            </div>
          </div>

          <template v-if="source === 'file'">
            <div class="space-y-2">
              <Label for="upload-file">文件（最大 25 MB）</Label>
              <Input
                id="upload-file"
                type="file"
                @change="
                  file = ($event.target as HTMLInputElement).files?.[0] || null
                "
              />
            </div>
            <p class="text-xs text-muted-foreground">
              上传后进入解析队列；达到可用状态后才参与 Agent 检索。
            </p>

            <details
              :open="advancedOpen"
              @toggle="advancedOpen = ($event.target as HTMLDetailsElement).open"
            >
              <summary class="cursor-pointer text-sm text-muted-foreground select-none hover:text-foreground">
                高级设置
              </summary>
              <div class="mt-3 space-y-4">
                <div class="grid grid-cols-3 gap-3">
                  <div class="space-y-2">
                    <Label>分块策略</Label>
                    <Select v-model="chunkStrategy">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动</SelectItem>
                        <SelectItem value="heading">按标题</SelectItem>
                        <SelectItem value="heuristic">启发式</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-2">
                    <Label for="chunk-size">块大小</Label>
                    <Input id="chunk-size" v-model.number="chunkSize" type="number" min="64" />
                  </div>
                  <div class="space-y-2">
                    <Label for="chunk-overlap">重叠</Label>
                    <Input id="chunk-overlap" v-model.number="chunkOverlap" type="number" min="0" />
                  </div>
                </div>

                <label class="flex items-center gap-2 text-sm">
                  <Checkbox v-model="enableParentChild" />
                  Parent-child 父子分块
                </label>
                <div v-if="enableParentChild" class="grid grid-cols-2 gap-3">
                  <div class="space-y-2">
                    <Label for="parent-chunk-size">父块大小</Label>
                    <Input id="parent-chunk-size" v-model.number="parentChunkSize" type="number" min="256" />
                  </div>
                  <div class="space-y-2">
                    <Label for="child-chunk-size">子块大小</Label>
                    <Input id="child-chunk-size" v-model.number="childChunkSize" type="number" min="64" />
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-3">
                  <div class="space-y-2">
                    <Label>PDF 解析引擎</Label>
                    <Select v-model="pdfEngine">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="builtin">内置</SelectItem>
                        <SelectItem value="markitdown">MarkItDown</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-2">
                    <Label>问题生成</Label>
                    <div class="flex items-center gap-2">
                      <label class="flex items-center gap-2 text-sm">
                        <Checkbox v-model="questionEnabled" />
                        启用
                      </label>
                      <Input
                        v-if="questionEnabled"
                        v-model.number="questionCount"
                        type="number"
                        min="1"
                        max="10"
                        class="w-16"
                      />
                    </div>
                  </div>
                </div>

                <label class="flex items-center gap-2 text-sm">
                  <Checkbox v-model="graphEnabled" />
                  提取实体关系（Graph）
                </label>
              </div>
            </details>
          </template>

          <template v-else-if="source === 'url'">
            <div class="space-y-2">
              <Label for="upload-url">网页地址</Label>
              <Input id="upload-url" v-model="url" placeholder="https://…" />
            </div>
          </template>

          <template v-else-if="source === 'manual'">
            <div class="space-y-2">
              <Label for="upload-title">标题</Label>
              <Input id="upload-title" v-model="title" />
            </div>
            <div class="space-y-2">
              <Label for="upload-content">内容</Label>
              <Textarea id="upload-content" v-model="content" :rows="8" />
            </div>
          </template>

          <template v-else>
            <div class="space-y-2">
              <Label for="faq-question">标准问题</Label>
              <Input id="faq-question" v-model="faqQuestion" />
            </div>
            <div class="space-y-2">
              <Label for="faq-answer">答案</Label>
              <Textarea id="faq-answer" v-model="faqAnswer" :rows="4" />
            </div>
            <div class="space-y-2">
              <Label for="faq-similar">相似问题（每行一条）</Label>
              <Textarea
                id="faq-similar"
                v-model="faqSimilar"
                :rows="3"
                placeholder="客户可能换一种问法…"
              />
            </div>
          </template>
        </div>
      </template>

      <DialogFooter>
        <Button variant="outline" @click="emit('close')">取消</Button>
        <Button v-if="source" :disabled="submitting" @click="submit">
          {{ submitting ? "提交中" : "开始导入" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
