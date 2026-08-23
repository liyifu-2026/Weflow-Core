<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Component } from "vue";
import { useRoute } from "vue-router";
import { useExtensionStore } from "../stores/extensions";

const route = useRoute();
const extensions = useExtensionStore();

const solutionId = computed(() => String(route.params.solutionId ?? ""));
const extensionId = computed(() => String(route.params.extensionId ?? ""));

const current = computed(() =>
  extensions.find(solutionId.value, extensionId.value),
);

const isModule = computed(() =>
  /\.(m?[jt]s)$/i.test(current.value?.extension.entry ?? ""),
);
const isSelfNested = computed(() => {
  const entry = current.value?.extension.entry ?? "";
  if (!entry) return false;
  try {
    const url = new URL(entry, window.location.origin);
    const base = import.meta.env.BASE_URL || "/";
    return (
      url.origin === window.location.origin &&
      (url.pathname === "/" || url.pathname.startsWith(base))
    );
  } catch {
    return false;
  }
});
const remoteComponent = ref<Component | null>(null);
const remoteMount = ref<((container: HTMLElement) => void) | null>(null);
const mountHost = ref<HTMLElement | null>(null);
const moduleError = ref("");

async function loadModule() {
  remoteComponent.value = null;
  remoteMount.value = null;
  moduleError.value = "";
  const entry = current.value?.extension.entry;
  if (!current.value || !entry || !isModule.value) return;
  try {
    const mod = await import(/* @vite-ignore */ entry);
    if (typeof mod.mount === "function") {
      remoteMount.value = mod.mount as (container: HTMLElement) => void;
    } else {
      remoteComponent.value = (mod.default ?? mod) as Component;
    }
    await nextTick();
    if (remoteMount.value && mountHost.value) {
      remoteMount.value(mountHost.value);
    }
  } catch (error) {
    moduleError.value =
      error instanceof Error ? error.message : "远程模块加载失败";
  }
}

watch(current, loadModule, { immediate: true });

onMounted(() => {
  if (!extensions.loaded) void extensions.load();
});
</script>

<template>
  <div class="wf-extension-page">
    <div v-if="!extensions.loaded" class="wf-panel">
      <div class="wf-panel-body">
        <span class="wf-skeleton">正在加载业务扩展…</span>
      </div>
    </div>
    <div v-else-if="!current" class="wf-empty">
      <div>
        <strong>业务扩展不存在</strong>
        <p>该业务方案未安装，或没有声明此扩展。</p>
      </div>
    </div>
    <div
      v-else-if="isModule && remoteComponent"
      class="wf-extension-module"
    >
      <component :is="remoteComponent" />
    </div>
    <div
      v-else-if="isModule && remoteMount"
      ref="mountHost"
      class="wf-extension-module"
    ></div>
    <div v-else-if="isModule && moduleError" class="wf-error" role="alert">
      {{ moduleError }}
    </div>
    <div v-else-if="!current.extension.entry" class="wf-empty">
      <div>
        <strong>该扩展没有独立前端页面</strong>
        <p>此插件只提供设置项或数据能力，不包含 Console 页面。</p>
      </div>
    </div>
    <div v-else-if="isSelfNested" class="wf-empty">
      <div>
        <strong>扩展页面未正确配置</strong>
        <p>
          当前扩展 entry 指向了 Console 自身，已阻止嵌套加载。请检查 solution
          manifest 中 <code>consoleExtensions[].entry</code>。
        </p>
      </div>
    </div>
    <div v-else class="wf-extension-frame">
      <iframe
        :src="current.extension.entry"
        :title="current.extension.title"
        frameborder="0"
      ></iframe>
    </div>
  </div>
</template>

<style scoped>
.wf-extension-page {
  padding: 0;
}
.wf-extension-frame {
  height: calc(100vh - 44px);
  min-height: 480px;
  border: 0;
  border-radius: 0;
  overflow: hidden;
  background: transparent;
}
.wf-extension-frame iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.wf-extension-module {
  min-height: calc(100vh - 44px);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
</style>
