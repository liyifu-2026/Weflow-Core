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
  <div class="wf-page wf-page-wide wf-admin-page">
    <header class="wf-page-head">
      <div>
        <h1>管理</h1>
        <p>白名单集中在此管理；系统开关、模型、群策略请前往「设置中心」。</p>
      </div>
    </header>

    <div class="wf-admin-body">
      <WhitelistTab />
    </div>
  </div>
</template>

<style scoped>
.wf-admin-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.wf-admin-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
