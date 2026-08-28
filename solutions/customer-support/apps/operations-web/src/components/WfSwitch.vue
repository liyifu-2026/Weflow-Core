<script setup lang="ts">
const props = defineProps<{
  modelValue: boolean;
  disabled?: boolean;
  label?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "change", value: boolean): void;
}>();

function toggle() {
  if (props.disabled) return;
  const next = !props.modelValue;
  emit("update:modelValue", next);
  emit("change", next);
}
</script>

<template>
  <button
    type="button"
    class="wf-switch"
    :class="{ on: modelValue, disabled }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="wf-switch-thumb"></span>
  </button>
</template>

<style scoped>
.wf-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--wf-border-strong);
  border-radius: 999px;
  background: var(--wf-surface-soft);
  cursor: pointer;
  transition:
    background var(--wf-motion-fast) var(--wf-ease-out),
    border-color var(--wf-motion-fast) var(--wf-ease-out);
  flex: 0 0 auto;
}
.wf-switch.on {
  background: var(--wf-primary);
  border-color: var(--wf-primary);
}
.wf-switch.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.wf-switch-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--wf-on-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transform: translateX(2px);
  transition: transform var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-switch.on .wf-switch-thumb {
  transform: translateX(20px);
}
</style>
