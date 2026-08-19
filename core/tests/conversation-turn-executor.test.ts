import { describe, expect, it } from "vitest";
import { ConversationTurnExecutor } from "../modules/agent/application/conversation-turn-executor.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ConversationTurnExecutor", () => {
  it("runs different conversations concurrently", async () => {
    const executor = new ConversationTurnExecutor();
    const release = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const started: string[] = [];

    const first = executor.run("conversation-a", async () => {
      started.push("a");
      firstStarted.resolve();
      await release.promise;
    });
    const second = executor.run("conversation-b", async () => {
      started.push("b");
      secondStarted.resolve();
      await release.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(started).toEqual(["a", "b"]);
    release.resolve();
    await Promise.all([first, second]);
  });

  it("serializes turns from the same conversation in arrival order", async () => {
    const executor = new ConversationTurnExecutor();
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const events: string[] = [];

    const first = executor.run("conversation-a", async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    const second = executor.run("conversation-a", () => {
      events.push("second:start");
      return Promise.resolve();
    });

    await firstStarted.promise;
    expect(events).toEqual(["first:start"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("continues a conversation after an earlier turn fails", async () => {
    const executor = new ConversationTurnExecutor();
    const events: string[] = [];

    const first = executor.run("conversation-a", () => {
      events.push("first");
      return Promise.reject(new Error("expected"));
    });
    const second = executor.run("conversation-a", () => {
      events.push("second");
      return Promise.resolve();
    });

    await expect(first).rejects.toThrow("expected");
    await second;
    expect(events).toEqual(["first", "second"]);
  });
});
