/**
 * Minimal Weflow runtime kernel.
 *
 * The kernel owns composition and lifecycle only. Domain/application modules
 * must receive their capabilities from a composition root and must not use
 * this registry as an ambient service locator.
 */

export type MaybePromise<T> = T | Promise<T>;

export type CapabilityToken<T> = {
  readonly id: string;
  /** TypeScript-only marker; it is never read at runtime. */
  readonly __type?: T;
};

export function capability<T>(id: string): CapabilityToken<T> {
  return { id };
}

export type KernelEventListener = (payload: unknown) => void | Promise<void>;

export type PluginState =
  | "registered"
  | "initializing"
  | "running"
  | "stopping"
  | "disposed"
  | "failed";

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

export type PluginDefinition = {
  name: string;
  provides: readonly CapabilityToken<unknown>[];
  requires: readonly CapabilityToken<unknown>[];
  setup?(context: PluginContext): MaybePromise<void>;
  start?(context: PluginContext): MaybePromise<void>;
  stop?(context: PluginContext): MaybePromise<void>;
  dispose?(context: PluginContext): MaybePromise<void>;
};

type ListenerEntry = {
  owner: string;
  listener: KernelEventListener;
};

type PluginRuntime = {
  definition: PluginDefinition;
  state: PluginState;
  effects: Array<() => MaybePromise<void>>;
  context?: PluginContext;
};

export type PluginDiagnostic = {
  name: string;
  state: PluginState;
  provides: string[];
  requires: string[];
  effectCount: number;
  listenerCount: number;
};

export type KernelDiagnostics = {
  started: boolean;
  graph: Array<{ plugin: string; dependsOn: string[] }>;
  plugins: PluginDiagnostic[];
};

export type RuntimeCapabilityStatus =
  "ready" | "unavailable" | "failed" | "stopped";

export type RuntimeCapabilityDiagnostic = {
  name: string;
  provider: string;
  status: RuntimeCapabilityStatus;
};

export type RuntimeInspection = {
  started: boolean;
  capabilities: RuntimeCapabilityDiagnostic[];
};

export class RuntimeKernel {
  private readonly plugins = new Map<string, PluginRuntime>();
  private readonly providers = new Map<string, string>();
  private readonly services = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<ListenerEntry>>();
  private startOrder: PluginRuntime[] = [];
  private started = false;

  register(plugin: PluginDefinition): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`plugin_duplicate:${plugin.name}`);
    }
    const provided = new Set<string>();
    for (const token of plugin.provides) {
      if (provided.has(token.id))
        throw new Error(`plugin_duplicate_capability:${token.id}`);
      provided.add(token.id);
      const existing = this.providers.get(token.id);
      if (existing) {
        throw new Error(
          `capability_duplicate:${token.id}:${existing}:${plugin.name}`,
        );
      }
      this.providers.set(token.id, plugin.name);
    }
    this.plugins.set(plugin.name, {
      definition: plugin,
      state: "registered",
      effects: [],
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.startOrder = this.resolveOrder();
    const initialized: PluginRuntime[] = [];
    try {
      for (const runtime of this.startOrder) {
        runtime.state = "initializing";
        const context = this.createContext(runtime);
        runtime.context = context;
        await runtime.definition.setup?.(context);
        await runtime.definition.start?.(context);
        runtime.state = "running";
        initialized.push(runtime);
      }
      this.started = true;
    } catch (error) {
      const failed = this.startOrder.find(
        (runtime) => runtime.state === "initializing",
      );
      if (failed) {
        await this.disposeRuntime(failed);
        failed.state = "failed";
      }
      for (const runtime of initialized.reverse())
        await this.disposeRuntime(runtime);
      this.startOrder = [];
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const runtime of [...this.startOrder].reverse()) {
      if (runtime.state === "running" || runtime.state === "failed") {
        await this.disposeRuntime(runtime);
      }
    }
    this.started = false;
  }

  get<T>(token: CapabilityToken<T>): T {
    if (!this.started) throw new Error("runtime_not_started");
    if (!this.services.has(token.id)) {
      throw new Error(`capability_unavailable:${token.id}`);
    }
    return this.services.get(token.id) as T;
  }

  diagnostics(): KernelDiagnostics {
    return {
      started: this.started,
      graph: [...this.plugins.values()].map((runtime) => ({
        plugin: runtime.definition.name,
        dependsOn: runtime.definition.requires.map(
          (token) => this.providers.get(token.id) ?? "<missing>",
        ),
      })),
      plugins: [...this.plugins.values()].map((runtime) => ({
        name: runtime.definition.name,
        state: runtime.state,
        provides: runtime.definition.provides.map((token) => token.id),
        requires: runtime.definition.requires.map((token) => token.id),
        effectCount: runtime.effects.length,
        listenerCount: this.listenerCount(runtime.definition.name),
      })),
    };
  }

  /**
   * Return a capability-oriented view for startup and support diagnostics.
   * This is intentionally read-only and does not perform provider health checks.
   */
  inspect(): RuntimeInspection {
    return {
      started: this.started,
      capabilities: [...this.providers.entries()].map(([name, provider]) => {
        const runtime = this.plugins.get(provider);
        let status: RuntimeCapabilityStatus = "unavailable";
        if (runtime?.state === "failed") status = "failed";
        else if (runtime?.state === "disposed") status = "stopped";
        else if (runtime?.state === "running" && this.services.has(name)) {
          status = "ready";
        }
        return { name, provider, status };
      }),
    };
  }

  private resolveOrder(): PluginRuntime[] {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const order: PluginRuntime[] = [];

    const visit = (runtime: PluginRuntime): void => {
      const name = runtime.definition.name;
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`plugin_cycle:${name}`);
      visiting.add(name);
      for (const token of runtime.definition.requires) {
        const providerName = this.providers.get(token.id);
        if (!providerName) {
          throw new Error(`capability_missing:${name}:${token.id}`);
        }
        const provider = this.plugins.get(providerName);
        if (!provider) throw new Error(`plugin_missing:${providerName}`);
        visit(provider);
      }
      visiting.delete(name);
      visited.add(name);
      order.push(runtime);
    };

    for (const runtime of this.plugins.values()) visit(runtime);
    return order;
  }

  private createContext(runtime: PluginRuntime): PluginContext {
    const declaredRequires = new Set(
      runtime.definition.requires.map((token) => token.id),
    );
    const declaredProvides = new Set(
      runtime.definition.provides.map((token) => token.id),
    );
    return {
      use: <T>(token: CapabilityToken<T>): T => {
        if (!declaredRequires.has(token.id)) {
          throw new Error(
            `capability_not_declared:${runtime.definition.name}:${token.id}`,
          );
        }
        if (!this.services.has(token.id)) {
          throw new Error(`capability_unavailable:${token.id}`);
        }
        return this.services.get(token.id) as T;
      },
      provide: <T>(token: CapabilityToken<T>, value: T): void => {
        if (!declaredProvides.has(token.id)) {
          throw new Error(
            `capability_not_declared:${runtime.definition.name}:${token.id}`,
          );
        }
        if (this.services.has(token.id)) {
          throw new Error(`capability_already_registered:${token.id}`);
        }
        this.services.set(token.id, value);
      },
      effect: (disposer) => {
        runtime.effects.push(disposer);
      },
      events: {
        on: (event, listener) => {
          const entry: ListenerEntry = {
            owner: runtime.definition.name,
            listener,
          };
          const entries = this.listeners.get(event) ?? new Set<ListenerEntry>();
          entries.add(entry);
          this.listeners.set(event, entries);
          const unsubscribe = (): void => {
            entries.delete(entry);
            if (entries.size === 0) this.listeners.delete(event);
          };
          runtime.effects.push(unsubscribe);
          return unsubscribe;
        },
        emit: async (event, payload) => {
          for (const entry of [...(this.listeners.get(event) ?? [])]) {
            await entry.listener(payload);
          }
        },
      },
    };
  }

  private async disposeRuntime(runtime: PluginRuntime): Promise<void> {
    if (runtime.state === "disposed") return;
    runtime.state = "stopping";
    const context = runtime.context;
    if (context) await runtime.definition.stop?.(context);
    for (const disposer of [...runtime.effects].reverse()) await disposer();
    runtime.effects.length = 0;
    if (context) await runtime.definition.dispose?.(context);
    for (const token of runtime.definition.provides) {
      this.services.delete(token.id);
    }
    runtime.state = "disposed";
  }

  private listenerCount(owner: string): number {
    let count = 0;
    for (const entries of this.listeners.values()) {
      for (const entry of entries) if (entry.owner === owner) count += 1;
    }
    return count;
  }
}
