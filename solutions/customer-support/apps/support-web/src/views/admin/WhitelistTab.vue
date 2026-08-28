<script setup lang="ts">
/**
 * 管理页 Tab：白名单配置。直接复用 WhitelistView，保持单一事实来源。
 */
import WhitelistView from "../WhitelistView.vue";
</script>

<template>
  <div class="wf-admin-tab">
    <WhitelistView />
  </div>
</template>

<style scoped>
.wf-admin-tab {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
</style>
