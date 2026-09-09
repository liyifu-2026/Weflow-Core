<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { computed, onMounted, ref } from "vue";
import { MoreVertical, Plus } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  createWikiPage,
  deleteWikiPage,
  getWikiPage,
  listWikiPages,
  updateWikiPage,
  type WikiPage,
} from "./api";
import { renderMiniMarkdown } from "./mini-markdown";

const props = defineProps<{ kbId: string }>();
const emit = defineEmits<{ error: [string] }>();

const pages = ref<WikiPage[]>([]);
const loading = ref(false);
const reading = ref<WikiPage | null>(null);
const readingHtml = ref("");
const editOpen = ref(false);
const editing = ref<WikiPage | null>(null);
const title = ref("");
const content = ref("");
const submitting = ref(false);

const pageSlug = (item: WikiPage) => String(item.slug ?? "");

// 树形展示：上游无 tree 端点，wiki_path 本身是层级事实（"index/Install/…"）。
const pageDepth = (item: WikiPage) => {
  const path = String(item.wiki_path ?? "");
  return path ? path.split("/").length - 1 : 0;
};

async function load() {
  if (!props.kbId) return;
  loading.value = true;
  try {
    pages.value = await listWikiPages(props.kbId);
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "Wiki 加载失败");
  } finally {
    loading.value = false;
  }
}

async function openRead(item: WikiPage) {
  if (!props.kbId || !pageSlug(item)) return;
  try {
    const page = await getWikiPage(props.kbId, pageSlug(item));
    reading.value = page;
    readingHtml.value = renderMiniMarkdown(page.content ?? "");
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "页面加载失败");
  }
}

function openCreate() {
  editing.value = null;
  title.value = "";
  content.value = "";
  editOpen.value = true;
}

function openEdit(item: WikiPage) {
  editing.value = item;
  title.value = item.title ?? "";
  content.value = item.content ?? "";
  editOpen.value = true;
}

async function save() {
  if (!props.kbId || !title.value.trim()) return;
  submitting.value = true;
  try {
    if (editing.value) {
      await updateWikiPage(props.kbId, pageSlug(editing.value), {
        title: title.value.trim(),
        content: content.value,
        version: editing.value.version,
      });
    } else {
      await createWikiPage(props.kbId, {
        title: title.value.trim(),
        content: content.value,
      });
    }
    editOpen.value = false;
    await load();
  } catch (reason) {
    emit("error", reason instanceof Error ? reason.message : "保存失败");
  } finally {
    submitting.value = false;
  }
}

async function remove(item: WikiPage) {
  if (!props.kbId || !pageSlug(item)) return;
  if (!await confirmDialog(`删除 Wiki 页面「${item.title}」？`)) return;
  try {
    await deleteWikiPage(props.kbId, pageSlug(item));
    if (reading.value?.slug === item.slug) reading.value = null;
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
      <span class="text-sm text-muted-foreground">Wiki 页面</span>
      <div class="flex-1"></div>
      <Button size="sm" @click="openCreate">
        <Plus class="size-4" />新建页面
      </Button>
    </div>

    <section class="flex flex-col" aria-label="Wiki 页面列表">
      <template v-if="loading">
        <div v-for="i in 4" :key="i" class="px-2 py-3">
          <Skeleton class="h-4 w-2/3" />
        </div>
      </template>
      <template v-else>
        <div
          v-for="item in pages"
          :key="pageSlug(item)"
          class="group flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-muted/50"
          :style="{ paddingLeft: `${(0.5 + pageDepth(item) * 1.25)}rem` }"
        >
          <button class="min-w-0 flex-1 text-left" @click="openRead(item)">
            <strong class="block truncate text-sm font-medium">{{ item.title || pageSlug(item) }}</strong>
            <span class="text-xs text-muted-foreground">
              {{ item.page_type || "页面" }} · v{{ item.version ?? "—" }}
            </span>
          </button>
          <span class="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">
            {{ item.updated_at ? new Date(item.updated_at).toLocaleDateString() : "—" }}
          </span>
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
              <DropdownMenuItem
                class="text-destructive focus:text-destructive"
                @click="remove(item)"
              >
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div v-if="!pages.length" class="rounded-md border border-dashed border-border p-8 text-center">
          <p class="text-sm font-medium">还没有 Wiki 页面</p>
          <p class="mt-1 text-sm text-muted-foreground">创建第一份 Wiki 页面，建立可追溯的组织知识。</p>
        </div>
      </template>
    </section>

    <Sheet
      :open="Boolean(reading)"
      @update:open="(value) => !value && (reading = null)"
    >
      <SheetContent side="right" class="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-xl">
        <SheetHeader class="text-left">
          <SheetTitle class="truncate pr-6">{{ reading?.title ?? "" }}</SheetTitle>
          <SheetDescription class="sr-only">Wiki 页面阅读</SheetDescription>
        </SheetHeader>
        <template v-if="reading">
          <div class="flex items-center justify-between px-4 pb-2">
            <p class="text-xs text-muted-foreground">
              {{ reading.page_type || "页面" }} · v{{ reading.version ?? "—" }} ·
              {{
                reading.updated_at
                  ? new Date(reading.updated_at).toLocaleString()
                  : "—"
              }}
            </p>
            <Button variant="outline" size="sm" @click="openEdit(reading)">编辑</Button>
          </div>
          <article class="md-body max-w-none px-4 pb-6" v-html="readingHtml"></article>
        </template>
      </SheetContent>
    </Sheet>

    <Dialog :open="editOpen" @update:open="(value) => (editOpen = value)">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? "编辑页面" : "新建页面" }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="wiki-title">标题</Label>
            <Input id="wiki-title" v-model="title" />
          </div>
          <div class="space-y-2">
            <Label for="wiki-content">内容（Markdown）</Label>
            <Textarea
              id="wiki-content"
              v-model="content"
              :rows="12"
              placeholder="# 标题&#10;&#10;正文…"
              class="font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="submitting || !title.trim()" @click="save">
            {{ submitting ? "保存中" : "保存" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
/* renderMiniMarkdown 输出原生标签（v-html 不带 scoped 属性），需语义化排版 */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--foreground);
  margin: 1.25em 0 0.5em;
}
.md-body :deep(h1) { font-size: 1.25rem; }
.md-body :deep(h2) { font-size: 1.125rem; }
.md-body :deep(h3),
.md-body :deep(h4) { font-size: 1rem; }
.md-body :deep(p) {
  margin: 0.5em 0;
  line-height: 1.7;
  color: var(--foreground);
}
.md-body :deep(ul) {
  margin: 0.5em 0;
  padding-left: 1.25em;
  list-style: disc;
  color: var(--foreground);
}
.md-body :deep(li) { margin: 0.25em 0; line-height: 1.6; }
.md-body :deep(a) {
  color: var(--foreground);
  text-decoration: underline;
  text-underline-offset: 4px;
}
.md-body :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.875em;
  background: var(--muted);
  border-radius: 4px;
  padding: 0.1em 0.3em;
}
.md-body :deep(pre) {
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
  margin: 0.75em 0;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
}
.md-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1.25em 0;
}
</style>
