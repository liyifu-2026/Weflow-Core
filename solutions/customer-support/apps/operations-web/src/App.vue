<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useWeflowAuthStore } from "./auth-store";
import ConfirmDialog from "./components/ConfirmDialog.vue";

const router = useRouter();
const auth = useWeflowAuthStore();

onMounted(async () => {
  await auth.ensureSession();
  if (!auth.isAdmin) {
    void router.replace("/");
  }
});
</script>

<template>
  <div class="wf-ops-shell">
    <main class="wf-ops-main">
      <router-view />
    </main>
    <ConfirmDialog />
  </div>
</template>

<style>
.wf-ops-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.wf-ops-main {
  flex: 1;
  padding: 24px;
}
</style>
