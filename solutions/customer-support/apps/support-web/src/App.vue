<script setup lang="ts">
import { useWeflowAuthStore } from "./auth-store";
import WfConfirmDialog from "./components/WfConfirmDialog.vue";

const auth = useWeflowAuthStore();
void auth.ensureSession();
</script>

<template>
  <router-view />
  <WfConfirmDialog />
</template>
