<script setup lang="ts">
/**
 * 管理页（admin only）：联系人策略（自动回复 / 仅人工 / 已拉黑）。
 * 系统开关与模型设置已收敛到设置中心（/settings，R2）。
 * 非管理员由路由守卫重定向回工作台。
 */
import { useWeflowAuthStore } from "../auth-store";
import WhitelistTab from "./admin/WhitelistTab.vue";

const auth = useWeflowAuthStore();
void auth.ensureSession();
</script>

<template>
  <div class="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col p-6">
    <header class="shrink-0">
      <h1 class="text-2xl font-semibold tracking-tight">管理</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        新联系人默认由 AI 自动回复；可在此设为「仅人工」或拉黑。系统开关、模型、群策略请前往「设置中心」。
      </p>
    </header>
    <div class="mt-6 flex min-h-0 flex-1 flex-col">
      <WhitelistTab />
    </div>
  </div>
</template>
