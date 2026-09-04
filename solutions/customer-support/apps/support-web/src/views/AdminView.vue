<script setup lang="ts">
/**
 * 管理页（admin only）：白名单配置。
 * 系统开关与模型设置已收敛到设置中心（/settings，R2）。
 * 非管理员由路由守卫重定向回工作台。
 */
import { useWeflowAuthStore } from "../auth-store";
import WhitelistTab from "./admin/WhitelistTab.vue";

const auth = useWeflowAuthStore();
void auth.ensureSession();
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="mx-auto w-full max-w-5xl shrink-0 p-6 pb-0">
      <header>
        <h1 class="text-2xl font-semibold tracking-tight">管理</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          白名单集中在此管理；系统开关、模型、群策略请前往「设置中心」。
        </p>
      </header>
    </div>
    <div class="min-h-0 flex-1">
      <WhitelistTab />
    </div>
  </div>
</template>
