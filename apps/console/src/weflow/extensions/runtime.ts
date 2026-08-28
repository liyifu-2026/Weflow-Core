/**
 * Platform ExtensionHost runtime helpers.
 *
 * Console 只负责加载并承载 Solution 声明的扩展入口（同源静态资源），
 * 不感知任何具体业务。挂载契约同时兼容两种形态：
 * - 新契约：`mount(el, ctx)` 返回 `{unmount, navigate}`（可异步）
 * - 旧契约：`mount(container)` 同步挂载、无返回值（卸载由宿主清空容器）
 */

export type ExtensionBridge = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  navigate: (fullPath: string) => void;
};

export type ExtensionUserSnapshot = Record<string, unknown> | null;

export type ExtensionMountContext = {
  path: string;
  user: ExtensionUserSnapshot;
  bridge: ExtensionBridge;
};

/** 扩展入口暴露的最小接口；多余导出被忽略。 */
export type ExtensionModule = {
  mount: (el: HTMLElement, context: ExtensionMountContext) => unknown;
  /** 旧式 UMD 配对的模块级卸载函数（可选）。 */
  unmount?: () => void;
};

/** 宿主持有的活动实例句柄；unmount/navigate 永远可用。 */
export type ExtensionMountHandle = {
  unmount: () => void;
  navigate: (fullPath: string) => void;
};

/**
 * 把 manifest 的 entry 解析为可 import 的绝对 URL。
 * - 绝对 URL / 根相对路径（/xxx）：原样基于 origin 解析；
 * - 相对路径（如 apps/support-web/dist/support-console.js）：
 *   映射到同源 solution-assets 前缀 /plugins/<solutionId>/<entry>，
 *   dev 由 vite 中间件、生产由 web 服务器托管该前缀。
 */
export function resolveEntryUrl(
  entry: string,
  options: { base?: string; solutionId?: string } = {},
): string {
  const origin = options.base ?? window.location.origin;
  const trimmed = entry.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("/")) {
    return new URL(trimmed, origin).href;
  }
  const solutionId = options.solutionId ?? "";
  return new URL(`/plugins/${solutionId}/${trimmed}`, origin).href;
}

type MountResultCandidate = {
  unmount?: unknown;
  navigate?: unknown;
};

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * 归一化 `mount()` 的返回值为统一的 MountHandle：
 * 1. 新契约句柄（含 unmount）：直接采用，navigate 缺省回落到宿主路由；
 * 2. 同步挂载 + 模块级 `unmount()`：调用后清空容器；
 * 3. 裸同步挂载（仅 `mount(container)`）：卸载即清空容器。
 */
export async function resolveMountHandle(options: {
  mountResult: unknown;
  mod: Partial<ExtensionModule> | null;
  container: HTMLElement;
  fallbackNavigate: (fullPath: string) => void;
}): Promise<ExtensionMountHandle> {
  const { mountResult, mod, container, fallbackNavigate } = options;
  const resolved = isThenable(mountResult) ? await mountResult : mountResult;

  if (typeof resolved === "object" && resolved !== null) {
    const candidate = resolved as MountResultCandidate;
    if (typeof candidate.unmount === "function") {
      const target = resolved as ExtensionMountHandle & object;
      const bundleUnmount = candidate.unmount as () => void;
      const bundleNavigate =
        typeof candidate.navigate === "function"
          ? (candidate.navigate as (fullPath: string) => void)
          : null;
      return {
        unmount: () => bundleUnmount.call(target),
        navigate:
          bundleNavigate !== null
            ? (fullPath: string) => bundleNavigate.call(target, fullPath)
            : fallbackNavigate,
      };
    }
  }

  if (mod && typeof mod.unmount === "function") {
    const moduleUnmount = mod.unmount;
    return {
      unmount: () => {
        try {
          moduleUnmount();
        } finally {
          container.innerHTML = "";
        }
      },
      navigate: fallbackNavigate,
    };
  }

  return {
    unmount: () => {
      container.innerHTML = "";
    },
    navigate: fallbackNavigate,
  };
}
