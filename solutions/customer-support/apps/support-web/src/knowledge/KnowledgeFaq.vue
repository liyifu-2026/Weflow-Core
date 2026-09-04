<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { onMounted, ref } from "vue";
import { MoreVertical, Plus, Search } from "lucide-vue-next";
import { useEscClose } from "../composables/use-esc-close";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createFAQEntry,
  deleteFAQEntries,
  listFAQEntries,
  updateFAQEntry,
  type FAQEntry,
} from "./api";

const props = defineProps<{ kbId: string }>();
const emit = defineEmits<{ error: [string] }>();

const entries = ref<FAQEntry[]>([]);
const loading = ref(false);
const keyword = ref("");
const editOpen = ref(false);
useEscClose(editOpen, () => { editOpen.value = false; });
const editing = ref<FAQEntry | null>(null);
const question = ref("");
const answer = ref("");
const similar = ref("");
const submitting = ref(false);

const entryId = (item: FAQEntry) => String(item.id ?? item.faq_id ?? "");
const entryQuestion = (item: FAQEntry) =>
  item.question || item.standard_question || "未命名问题";

async function load() {
  if (!props.kbId) return;
  loading.value = true;
  try {
    entries.value = await listFAQEntries(props.kbId, {
      keyword: keyword.value.trim() || undefined,
      page_size: 100,
    });
  } catch (reason) {
    emit(
      "error",
      reason instanceof Error ? reason.message : "FAQ 加载失败",
    );
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  question.value = "";
  answer.value = "";
  similar.value = "";
  editOpen.value = true;
}

function openEdit(item: FAQEntry) {
  editing.value = item;
  question.value = entryQuestion(item);
  answer.value = item.answer ?? "";
  similar.value = (item.similar_questions ?? []).join("\n");
  editOpen.value = true;
}

async function save() {
  if (!props.kbId || !question.value.trim()) return;
  submitting.value = true;
  try {
    const payload = {
      question: question.value.trim(),
      answer: answer.value,
      similar_questions: similar.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    };
    if (editing.value) {
      await updateFAQEntry(props.kbId, entryId(editing.value), payload);
    } else {
      await createFAQEntry(props.kbId, payload);
    }
    editOpen.value = false;
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "FAQ 保存失败");
  } finally {
    submitting.value = false;
  }
}

async function toggleEnabled(item: FAQEntry) {
  try {
    await updateFAQEntry(props.kbId, entryId(item), {
      is_enabled: item.is_enabled === false,
    });
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "更新失败");
  }
}

async function remove(item: FAQEntry) {
  if (!await confirmDialog(`删除 FAQ「${entryQuestion(item)}」？`)) return;
  try {
    await deleteFAQEntries(props.kbId, [entryId(item)]);
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "删除失败");
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex items-center gap-2">
      <div class="flex min-w-48 flex-1 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 sm:max-w-sm">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          v-model="keyword"
          class="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="搜索 FAQ…"
          @keyup.enter="load()"
        />
      </div>
      <div class="flex-1"></div>
      <Button size="sm" @click="openCreate">
        <Plus class="size-4" />添加 FAQ
      </Button>
    </div>

    <section class="flex flex-col" aria-label="FAQ 列表">
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="px-2 py-3">
          <Skeleton class="h-4 w-2/3" />
        </div>
      </template>
      <template v-else>
        <div
          v-for="item in entries"
          :key="entryId(item)"
          class="group flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/50"
        >
          <div class="min-w-0 flex-1">
            <strong class="block text-sm font-medium">{{ entryQuestion(item) }}</strong>
            <span class="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{{ item.answer || "无答案" }}</span>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Badge v-if="item.is_enabled === false" variant="outline">已停用</Badge>
            <span v-else-if="item.is_recommended" class="text-xs text-muted-foreground">· 推荐</span>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon"
                  class="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  title="更多操作"
                >
                  <MoreVertical class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @click="openEdit(item)">编辑</DropdownMenuItem>
                <DropdownMenuItem @click="toggleEnabled(item)">
                  {{ item.is_enabled === false ? "启用" : "停用" }}
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="text-destructive focus:text-destructive"
                  @click="remove(item)"
                >
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div v-if="!entries.length" class="rounded-md border border-dashed border-border p-8 text-center">
          <p class="text-sm font-medium">还没有 FAQ</p>
          <p class="mt-1 text-sm text-muted-foreground">添加标准问题与答案，Agent 会优先使用 FAQ 回答。</p>
        </div>
      </template>
    </section>

    <Dialog :open="editOpen" @update:open="(value) => (editOpen = value)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ editing ? "编辑 FAQ" : "添加 FAQ" }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="faq-edit-question">标准问题</Label>
            <Input id="faq-edit-question" v-model="question" />
          </div>
          <div class="space-y-2">
            <Label for="faq-edit-answer">答案</Label>
            <Textarea id="faq-edit-answer" v-model="answer" :rows="5" />
          </div>
          <div class="space-y-2">
            <Label for="faq-edit-similar">相似问题（每行一条）</Label>
            <Textarea
              id="faq-edit-similar"
              v-model="similar"
              :rows="3"
              placeholder="客户可能换一种问法…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="submitting || !question.trim()" @click="save">
            {{ submitting ? "保存中" : "保存" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
