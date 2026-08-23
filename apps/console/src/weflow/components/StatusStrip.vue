<script setup lang="ts">
import WfIcon from "./WfIcon.vue";

defineProps<{
  tone?: "good" | "warn" | "bad" | "inactive" | "accent" | "neutral";
  label: string;
  value: string;
  meta?: string;
  chips?: string[];
  quiet?: string;
  to?: string;
}>();
</script>

<template>
  <component
    :is="to ? 'router-link' : 'div'"
    class="wf-status-strip"
    :class="tone ?? 'inactive'"
    :to="to"
  >
    <span class="wf-status-strip-dot" aria-hidden="true"></span>
    <span class="wf-status-strip-copy">
      <span class="wf-status-strip-label">{{ label }}</span>
      <strong>{{ value }}</strong>
    </span>
    <span v-if="meta" class="wf-status-strip-meta">{{ meta }}</span>
    <span v-if="chips?.length" class="wf-status-strip-issues">
      <span v-for="chip in chips.slice(0, 3)" :key="chip" class="wf-status-strip-chip">
        {{ chip }}
      </span>
      <span v-if="chips.length > 3" class="wf-status-strip-chip">+{{ chips.length - 3 }}</span>
    </span>
    <span v-else-if="quiet" class="wf-status-strip-quiet">{{ quiet }}</span>
    <WfIcon v-if="to" name="chevron" :size="16" class="wf-status-strip-arrow" />
  </component>
</template>

<style scoped>
.wf-status-strip {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 14px 18px;
  border: 1px solid var(--wf-border);
  border-radius: 12px;
  background: var(--wf-surface);
  color: inherit;
  text-decoration: none;
  box-shadow: none;
  transition:
    border-color var(--wf-motion-fast) var(--wf-ease-out),
    box-shadow var(--wf-motion-fast) var(--wf-ease-out);
}
a.wf-status-strip:hover {
  border-color: var(--wf-border-strong);
  box-shadow: none;
}
.wf-status-strip-dot {
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  border-radius: 50%;
  background: var(--wf-text-muted);
}
.wf-status-strip.good .wf-status-strip-dot,
.wf-status-strip.accent .wf-status-strip-dot {
  background: var(--wf-success);
  box-shadow: 0 0 0 4px var(--wf-success-soft);
}
.wf-status-strip.warn .wf-status-strip-dot {
  background: var(--wf-warning);
  box-shadow: 0 0 0 4px var(--wf-warning-soft);
}
.wf-status-strip.bad .wf-status-strip-dot {
  background: var(--wf-danger);
  box-shadow: 0 0 0 4px var(--wf-danger-soft);
}
.wf-status-strip-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.wf-status-strip-label {
  color: var(--wf-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.wf-status-strip-copy strong {
  font-size: 16px;
  letter-spacing: -0.01em;
}
.wf-status-strip-meta {
  color: var(--wf-text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.wf-status-strip-issues {
  display: flex;
  gap: 6px;
  flex: 1;
  justify-content: flex-end;
  flex-wrap: wrap;
}
.wf-status-strip-chip {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--wf-surface-soft);
  color: var(--wf-text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.wf-status-strip-quiet {
  flex: 1;
  text-align: right;
  color: var(--wf-text);
  font-size: 12px;
  font-weight: 600;
}
.wf-status-strip-arrow {
  color: var(--wf-text-muted);
  transition: transform var(--wf-motion-fast) var(--wf-ease-out);
}
a.wf-status-strip:hover .wf-status-strip-arrow {
  transform: translateX(2px);
  color: var(--wf-text);
}
</style>
