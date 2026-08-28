<script setup lang="ts">
import { confirmDialogState } from "../confirm-dialog";

function close(value: boolean) {
  confirmDialogState.resolve?.(value);
  confirmDialogState.open = false;
  confirmDialogState.resolve = null;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="confirmDialogState.open"
      class="wf-modal-mask"
      @click.self="close(false)"
    >
      <div
        class="wf-modal wf-modal-narrow"
        role="alertdialog"
        aria-modal="true"
        aria-label="确认操作"
      >
        <div class="wf-modal-body">
          <p class="wf-confirm-message">{{ confirmDialogState.message }}</p>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="close(false)">取消</button>
          <button
            class="wf-button"
            :class="confirmDialogState.danger ? 'danger' : 'primary'"
            @click="close(true)"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style>
.wf-confirm-message {
  margin: 0;
  color: var(--wf-text);
  font-size: var(--wf-type-body);
  line-height: 1.6;
  white-space: pre-line;
}
</style>
