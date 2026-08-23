/**
 * RuntimeKernel 插件契约——唯一权威定义。
 *
 * Core 的 `infrastructure/runtime/kernel/index.ts` 与 Solution 插件加载器
 * （solution-plugin-loader / solution-plugin-adapter）都从这里消费；
 * `@weflow/plugin-sdk` 不得再定义同名但不同语义的 PluginDefinition。
 */

export type MaybePromise<T> = T | Promise<T>;

/** Kernel capability token. The `__type` marker is TypeScript-only. */
export type CapabilityToken<T> = {
  readonly id: string;
  readonly __type?: T;
};

/** Create a capability token; the id is the stable wire identity. */
export function capability<T>(id: string): CapabilityToken<T> {
  return { id };
}

export type KernelEventListener = (payload: unknown) => void | Promise<void>;

export type PluginContext = {
  /** Resolve a capability explicitly declared in the plugin's requires list. */
  use<T>(token: CapabilityToken<T>): T;
  /** Register a capability explicitly declared in the plugin's provides list. */
  provide<T>(token: CapabilityToken<T>, value: T): void;
  /** Register an owned disposer. Disposers run in reverse registration order. */
  effect(disposer: () => MaybePromise<void>): void;
  /** Event subscriptions are automatically owned by the current plugin. */
  events: {
    on(event: string, listener: KernelEventListener): () => void;
    emit(event: string, payload: unknown): Promise<void>;
  };
};

/**
 * Runtime registration shape of a loaded plugin.
 *
 * This is the runtime seam between the Solution Store loader and the
 * RuntimeKernel. Authoring-time manifests live in `@weflow/plugin-sdk`
 * (`RuntimePluginManifest`) and must be adapted into this shape exactly once,
 * in the platform's adapter layer.
 */
export type PluginDefinition = {
  name: string;
  provides: readonly CapabilityToken<unknown>[];
  requires: readonly CapabilityToken<unknown>[];
  setup?(context: PluginContext): MaybePromise<void>;
  start?(context: PluginContext): MaybePromise<void>;
  stop?(context: PluginContext): MaybePromise<void>;
  dispose?(context: PluginContext): MaybePromise<void>;
};
