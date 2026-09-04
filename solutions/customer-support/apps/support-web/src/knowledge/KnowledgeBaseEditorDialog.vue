<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
import { ref } from "vue";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  updateKnowledgeBase,
  type KnowledgeBase,
} from "./api";

const props = defineProps<{ base?: KnowledgeBase | null }>();
const emit = defineEmits<{ close: []; done: [] }>();

const name = ref(props.base?.name ?? "");
useEscClose(ref(true), () => emit("close"));
const description = ref(props.base?.description ?? "");
const type = ref<"document" | "faq">(props.base?.type ?? "document");
const submitting = ref(false);
const error = ref("");

async function save() {
  if (!name.value.trim()) return;
  submitting.value = true;
  error.value = "";
  try {
    if (props.base) {
      await updateKnowledgeBase(props.base.id, {
        name: name.value.trim(),
        description: description.value.trim(),
      });
    } else {
      await createKnowledgeBase({
        name: name.value.trim(),
        description: description.value.trim(),
        type: type.value,
      });
    }
    emit("done");
    emit("close");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "保存失败";
  } finally {
    submitting.value = false;
  }
}

async function remove() {
  if (!props.base) return;
  if (
    !await confirmDialog(
      `删除知识库「${props.base.name}」？其中的内容会一并删除，该操作会被审计。`,
    )
  )
    return;
  submitting.value = true;
  error.value = "";
  try {
    await deleteKnowledgeBase(props.base.id);
    emit("done");
    emit("close");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "删除失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(value) => !value && emit('close')">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ base ? "知识库设置" : "新建知识库" }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <div class="space-y-2">
          <Label for="kb-name">名称</Label>
          <Input id="kb-name" v-model="name" placeholder="例如：产品售后手册" />
        </div>
        <div class="space-y-2">
          <Label for="kb-description">用途说明</Label>
          <Textarea
            id="kb-description"
            v-model="description"
            :rows="3"
            placeholder="说明 Agent 应在什么问题下使用这里的资料"
          />
        </div>
        <div v-if="!base" class="space-y-2">
          <Label>类型</Label>
          <Select v-model="type">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="document">文档</SelectItem>
              <SelectItem value="faq">FAQ</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p v-if="base" class="text-xs text-muted-foreground">
          解析、分块与模型等高级配置将在后续版本开放。
        </p>
      </div>

      <DialogFooter class="sm:justify-between">
        <Button
          v-if="base"
          variant="ghost"
          class="text-destructive hover:bg-destructive/10 hover:text-destructive"
          :disabled="submitting"
          @click="remove"
        >
          删除知识库
        </Button>
        <div class="flex gap-2 sm:ml-auto">
          <Button variant="outline" @click="emit('close')">取消</Button>
          <Button :disabled="submitting || !name.trim()" @click="save">
            {{ submitting ? "保存中" : base ? "保存" : "创建知识库" }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
