import { describe, expect, it } from "vitest";
import {
  RuntimeKernel,
  capability,
  type PluginDefinition,
} from "../infrastructure/runtime/kernel/index.js";

const database = capability<string>("database");
const repository = capability<string>("repository");

describe("RuntimeKernel", () => {
  it("resolves declared dependencies and reports the graph", async () => {
    const order: string[] = [];
    const kernel = new RuntimeKernel();
    kernel.register({
      name: "repositories",
      provides: [repository],
      requires: [database],
      setup(context) {
        order.push("repositories.setup");
        context.provide(repository, context.use(database) + ":repo");
      },
      start: () => {
        order.push("repositories.start");
      },
    });
    kernel.register({
      name: "postgres",
      provides: [database],
      requires: [],
      setup(context) {
        order.push("postgres.setup");
        context.provide(database, "postgres");
      },
      start: () => {
        order.push("postgres.start");
      },
    });

    await kernel.start();
    expect(order).toEqual([
      "postgres.setup",
      "postgres.start",
      "repositories.setup",
      "repositories.start",
    ]);
    expect(kernel.get(repository)).toBe("postgres:repo");
    expect(kernel.diagnostics().graph).toEqual([
      { plugin: "repositories", dependsOn: ["postgres"] },
      { plugin: "postgres", dependsOn: [] },
    ]);
    await kernel.stop();
  });

  it("inspects capability providers and readiness", async () => {
    const kernel = new RuntimeKernel();
    kernel.register({
      name: "postgres",
      provides: [database],
      requires: [],
      setup(context) {
        context.provide(database, "postgres");
      },
    });

    expect(kernel.inspect()).toMatchObject({
      started: false,
      capabilities: [
        { name: "database", provider: "postgres", status: "unavailable" },
      ],
    });
    await kernel.start();
    expect(kernel.inspect()).toMatchObject({
      started: true,
      capabilities: [
        { name: "database", provider: "postgres", status: "ready" },
      ],
    });
    await kernel.stop();
    expect(kernel.inspect()).toMatchObject({
      started: false,
      capabilities: [
        { name: "database", provider: "postgres", status: "stopped" },
      ],
    });
  });

  it("rejects missing and circular dependencies", async () => {
    const missing = capability("missing");
    const kernel = new RuntimeKernel();
    kernel.register({ name: "consumer", provides: [], requires: [missing] });
    await expect(kernel.start()).rejects.toThrow(
      "capability_missing:consumer:missing",
    );

    const left = capability("left");
    const right = capability("right");
    const cycle = new RuntimeKernel();
    cycle.register({ name: "left", provides: [left], requires: [right] });
    cycle.register({ name: "right", provides: [right], requires: [left] });
    await expect(cycle.start()).rejects.toThrow("plugin_cycle:left");
  });

  it("disposes effects in reverse order and removes event listeners", async () => {
    const events: string[] = [];
    const kernel = new RuntimeKernel();
    const plugin: PluginDefinition = {
      name: "effects",
      provides: [],
      requires: [],
      setup(context) {
        context.effect(() => {
          events.push("first.dispose");
        });
        context.effect(() => {
          events.push("second.dispose");
        });
        context.events.on("fact", () => {
          events.push("listener");
        });
        context.effect(() => {
          events.push("listener.dispose");
        });
      },
    };
    kernel.register(plugin);
    await kernel.start();
    const runtime = kernel.diagnostics().plugins[0];
    expect(runtime).toMatchObject({
      state: "running",
      effectCount: 4,
      listenerCount: 1,
    });
    await kernel.stop();
    expect(events).toEqual([
      "listener.dispose",
      "second.dispose",
      "first.dispose",
    ]);
    expect(kernel.diagnostics().plugins[0]).toMatchObject({
      state: "disposed",
      effectCount: 0,
      listenerCount: 0,
    });
  });

  it("does not allow undeclared capability access", async () => {
    const kernel = new RuntimeKernel();
    kernel.register({
      name: "provider",
      provides: [database],
      requires: [],
      setup(context) {
        context.provide(database, "postgres");
      },
    });
    kernel.register({
      name: "consumer",
      provides: [],
      requires: [],
      setup(context) {
        context.use(database);
      },
    });
    await expect(kernel.start()).rejects.toThrow(
      "capability_not_declared:consumer:database",
    );
  });

  it("cleans effects when plugin startup fails", async () => {
    const disposed: string[] = [];
    const kernel = new RuntimeKernel();
    kernel.register({
      name: "failing",
      provides: [],
      requires: [],
      setup(context) {
        context.effect(() => {
          disposed.push("effect");
        });
        throw new Error("startup_failed");
      },
    });
    await expect(kernel.start()).rejects.toThrow("startup_failed");
    expect(disposed).toEqual(["effect"]);
    expect(kernel.diagnostics().plugins[0]).toMatchObject({
      state: "failed",
      effectCount: 0,
    });
  });
});
