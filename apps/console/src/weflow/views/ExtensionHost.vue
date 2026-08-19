<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useExtensionStore } from "../stores/extensions";

const route = useRoute();
const router = useRouter();
const extensions = useExtensionStore();

const solutionId = computed(() => String(route.params.solutionId ?? ""));
const extensionId = computed(() => String(route.params.extensionId ?? ""));

const current = computed(() =>
  extensions.find(solutionId.value, extensionId.value),
);
const solutionTitle = computed(() =>
  current.value
    ? `${current.value.solution.solutionId} · v${current.value.solution.version}`
    : "",
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
  <div class="wf-page wf-page-wide">
    <header class="wf-page-head">
      <div>
        <button class="wf-link" @click="router.back()">← 返回</button>
        <h1>{{ current?.extension.title ?? "业务扩展" }}</h1>
        <p v-if="solutionTitle" class="wf-page-subtitle">
          {{ solutionTitle }}
        </p>
      </div>
    </header>

    <div v-if="!extensions.loaded" class="wf-panel">
      <span class="wf-skeleton">正在加载业务扩展…</span>
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
    <div v-else-if="isModule && moduleError" class="wf-error">
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
.wf-page-subtitle {
  margin: 2px 0 0;
  color: var(--wf-text-muted);
  font-size: var(--wf-type-secondary);
}
.wf-extension-frame {
  height: calc(100vh - 180px);
  min-height: 480px;
  margin-top: 12px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-popover);
  overflow: hidden;
  background: var(--wf-surface);
}
.wf-extension-frame iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}
.wf-extension-module {
  margin-top: 12px;
  min-height: 400px;
  padding: 16px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-popover);
  background: var(--wf-surface);
}
</style>
