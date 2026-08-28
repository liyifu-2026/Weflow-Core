<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ConsoleExtensionProjection } from "@weflow-leaif/contracts";
import { useWeflowAuthStore } from "../auth-store";
import {
  flattenProjections,
  matchExtension,
  useExtensionStore,
} from "../stores/extensions";
import {
  resolveEntryUrl,
  resolveMountHandle,
  type ExtensionModule,
  type ExtensionMountHandle,
} from "../extensions/runtime";

/**
 * Platform ExtensionHost（承载壳，业务中立）。
 *
 * 通过同源请求加载 Solution 声明的扩展入口并按 `mount(el, ctx)` 契约挂载；
 * 扩展只会拿到受限 bridge（fetch / navigate），永远不会拿到平台 store 或
 * router 实例。同时兼容旧式同步 `mount(container)` 挂载（卸载时清空容器）。
 */
const route = useRoute();
const router = useRouter();
const auth = useWeflowAuthStore();
const store = useExtensionStore();

type Status = "loading" | "ready" | "error" | "missing" | "static";

const container = ref<HTMLElement | null>(null);
const status = ref<Status>("loading");
const errorMessage = ref("");

let activeHandle: ExtensionMountHandle | null = null;
let mountSequence = 0;
const bundleCache = new Map<string, Promise<ExtensionModule>>();

async function loadBundle(entryUrl: string): Promise<ExtensionModule> {
  const cached = bundleCache.get(entryUrl);
  if (cached) return cached;
  const promise = (async () => {
    const mod = (await import(/* @vite-ignore */ entryUrl)) as Partial<ExtensionModule>;
    if (typeof mod?.mount !== "function")
      throw new Error("扩展入口无效（缺少 mount 函数）");
    return mod as ExtensionModule;
  })();
  bundleCache.set(entryUrl, promise);
  promise.catch(() => bundleCache.delete(entryUrl));
  return promise;
}

/** 显式路由（/extensions/:solutionId/:extensionId）优先；否则按声明路径匹配。 */
function resolveTarget(): ConsoleExtensionProjection | null {
  const solutionId = route.params.solutionId;
  if (typeof solutionId === "string" && solutionId) {
    const extensionId = String(route.params.extensionId ?? "");
    return store.find(solutionId, extensionId)?.extension ?? null;
  }
  return matchExtension(
    flattenProjections(store.solutions),
    route.path,
  );
}

function readOnlyUser(): Record<string, unknown> | null {
  const user = auth.user;
  if (!user) return null;
  return {
    userId: user.userId,
    username: user.username,
    role: user.role,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
    tags: user.tags ? [...user.tags] : [],
  };
}

function teardown() {
  try {
    activeHandle?.unmount();
  } finally {
    activeHandle = null;
  }
}

async function render() {
  const token = ++mountSequence;
  await store.load();
  if (token !== mountSequence) return;

  if (store.loadError) {
    status.value = "error";
    errorMessage.value = store.loadError;
    teardown();
    return;
  }

  const target = resolveTarget();
  if (!target) {
    status.value = "missing";
    teardown();
    return;
  }
  if (target.adminOnly && !auth.isAdmin) {
    status.value = "missing";
    teardown();
    return;
  }
  if (!target.entry) {
    status.value = "static";
    teardown();
    return;
  }

  let mod: ExtensionModule;
  try {
    mod = await loadBundle(
      resolveEntryUrl(target.entry, { solutionId: target.solutionId }),
    );
  } catch (reason) {
    if (token !== mountSequence) return;
    status.value = "error";
    errorMessage.value =
      reason instanceof Error && reason.message ? reason.message : "扩展加载失败";
    teardown();
    return;
  }
  if (token !== mountSequence || !container.value) return;
  teardown();
  try {
    const mountResult = mod.mount(container.value, {
      // 传 manifest 声明的业务 path（如 /support/knowledge），
      // 而非宿主路由（/extensions/<solutionId>/<extensionId>）——
      // 扩展内部路由按声明 path 定位页面。
      path: target.path,
      user: readOnlyUser(),
      bridge: {
        fetch: (path, init) => fetch(path, { ...init, credentials: "include" }),
        navigate: (fullPath) => {
          void router.push(fullPath).catch(() => undefined);
        },
      },
    });
    activeHandle = await resolveMountHandle({
      mountResult,
      mod,
      container: container.value,
      fallbackNavigate: (fullPath) => {
        void router.push(fullPath).catch(() => undefined);
      },
    });
    if (token !== mountSequence) {
      teardown();
      return;
    }
    status.value = "ready";
  } catch (reason) {
    status.value = "error";
    errorMessage.value =
      reason instanceof Error && reason.message ? reason.message : "扩展挂载失败";
  }
}

async function reload() {
  bundleCache.clear();
  await render();
}

watch(() => route.fullPath, () => void render());
watch(container, (value, previous) => {
  if (value && value !== previous) void render();
});

onBeforeUnmount(teardown);
</script>

<template>
  <div class="wf-extension-page">
    <div v-if="status === 'loading'" class="wf-panel">
      <div class="wf-panel-body">
        <span class="wf-skeleton">正在加载业务扩展…</span>
      </div>
    </div>
    <div v-else-if="status === 'error'" class="wf-error" role="alert">
      <span>{{ errorMessage }}</span>
      <button class="wf-button compact" @click="reload">重试</button>
    </div>
    <div v-else-if="status === 'missing'" class="wf-empty">
      <div>
        <strong>未找到对应的业务扩展</strong>
        <p>该地址由已安装的业务方案提供。方案可能未安装、未激活或已被停用。</p>
        <router-link class="wf-link" to="/">返回平台首页</router-link>
      </div>
    </div>
    <div v-else-if="status === 'static'" class="wf-empty">
      <div>
        <strong>该扩展没有独立前端页面</strong>
        <p>此插件只提供设置项或数据能力，不包含 Console 页面。</p>
      </div>
    </div>
    <div
      v-show="status === 'ready'"
      ref="container"
      class="wf-extension-module"
    ></div>
  </div>
</template>

<style scoped>
.wf-extension-page {
  padding: 0;
}
.wf-extension-module {
  min-height: calc(100vh - 44px);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
</style>
