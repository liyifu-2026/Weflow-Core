<script setup lang="ts">
/**
 * 管理页 Tab：联系人策略（自动回复 / 仅人工 / 已拉黑）。直接复用 WhitelistView，保持单一事实来源。
 */
import WhitelistView from "../WhitelistView.vue";
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"
  >
    <WhitelistView />
  </div>
</template>
