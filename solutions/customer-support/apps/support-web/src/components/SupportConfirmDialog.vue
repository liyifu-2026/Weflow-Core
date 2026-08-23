<script setup lang="ts">
import { supportConfirmState } from "./confirm";

function close(value: boolean) {
  supportConfirmState.resolve?.(value);
  supportConfirmState.open = false;
  supportConfirmState.resolve = null;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="supportConfirmState.open"
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
          <p class="support-confirm-message">{{ supportConfirmState.message }}</p>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="close(false)">取消</button>
          <button
            class="wf-button"
            :class="supportConfirmState.danger ? 'wf-button-danger' : 'primary'"
            @click="close(true)"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.support-confirm-message {
  margin: 0;
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-line;
}
.wf-button-danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
}
</style>
