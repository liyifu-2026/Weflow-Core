<script setup lang="ts">
/**
 * 共享确认弹窗（promise 化 confirmDialog 的展示层）。
 * 用 shadcn AlertDialog 实现；confirmDialog() 在 App.vue 挂载的本组件上全局生效。
 */
import { confirmDialogState } from "./confirm-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { buttonVariants } from "./ui/button";

function close(value: boolean) {
  confirmDialogState.resolve?.(value);
  confirmDialogState.open = false;
  confirmDialogState.resolve = null;
}
</script>

<template>
  <AlertDialog
    :open="confirmDialogState.open"
    @update:open="(open: boolean) => !open && close(false)"
  >
    <AlertDialogContent class="max-w-sm">
      <AlertDialogHeader>
        <AlertDialogTitle>确认操作</AlertDialogTitle>
        <AlertDialogDescription class="whitespace-pre-line">
          {{ confirmDialogState.message }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel @click="close(false)">取消</AlertDialogCancel>
        <AlertDialogAction
          :class="buttonVariants({ variant: confirmDialogState.danger ? 'destructive' : 'default' })"
          @click="close(true)"
        >
          确认
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
