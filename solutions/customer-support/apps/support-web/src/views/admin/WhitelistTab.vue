<script setup lang="ts">
/**
 * 管理页 Tab：白名单配置。直接复用 WhitelistView，保持单一事实来源。
 */
import WhitelistView from "../WhitelistView.vue";
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <WhitelistView />
  </div>
</template>
