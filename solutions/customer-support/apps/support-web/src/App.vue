<script setup lang="ts">
import { useWeflowAuthStore } from "./auth-store";
import WfConfirmDialog from "./components/WfConfirmDialog.vue";

const auth = useWeflowAuthStore();
void auth.ensureSession();
</script>

<template>
  <div class="wf-app-shell">
    <main class="wf-app-main">
      <router-view />
    </main>
    <WfConfirmDialog />
  </div>
</template>

<style scoped>
.wf-app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  background: var(--wf-bg, #f6f7f9);
}

.wf-app-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--wf-bg, #f6f7f9);
}

</style>
