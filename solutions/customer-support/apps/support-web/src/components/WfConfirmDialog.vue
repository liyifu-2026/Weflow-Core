<script setup lang="ts">
/**
 * 共享确认弹窗（promise 化 confirmDialog 的展示层）。
 * 用 shadcn AlertDialog 实现；confirmDialog() 在 App.vue 挂载的本组件上全局生效。
 *
 * 注意：确认/取消按钮刻意用普通 Button 而非 reka 的 AlertDialogAction/Cancel——
 * 后者自带「点击即关闭」，其内部 onOpenChange(false) 会先于按钮上的 @click
 * 触发并把 promise 结算成 false（表现为确认永远等于取消）。这里改为完全受控：
 * 按钮只调用 settle()，结算与关窗都由本组件状态驱动，与 reka 内部时序无关。
 */
import { watch } from "vue";
import { confirmDialogState } from "./confirm-dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { buttonVariants } from "./ui/button";

/** 幂等守卫：无论关闭来源（按钮 / ESC / 遮罩），只结算一次 */
let settled = false;

function settle(value: boolean) {
  if (settled) return;
  settled = true;
  confirmDialogState.resolve?.(value);
  confirmDialogState.open = false;
  confirmDialogState.resolve = null;
}

function onOpenChange(open: boolean) {
  // ESC / 点击遮罩等 reka 发起的关闭都走这里，按未确认结算
  if (!open) settle(false);
}

// 新弹窗打开时复位结算守卫（settled 是跨弹窗的组件级状态）
watch(
  () => confirmDialogState.open,
  (open) => {
    if (open) settled = false;
  },
);
</script>

<template>
  <AlertDialog
    :open="confirmDialogState.open"
    @update:open="onOpenChange"
  >
    <AlertDialogContent class="max-w-sm">
      <AlertDialogHeader>
        <AlertDialogTitle>确认操作</AlertDialogTitle>
        <AlertDialogDescription class="whitespace-pre-line">
          {{ confirmDialogState.message }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button variant="outline" @click="settle(false)">取消</Button>
        <Button
          :class="buttonVariants({ variant: confirmDialogState.danger ? 'destructive' : 'default' })"
          @click="settle(true)"
        >
          确认
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
