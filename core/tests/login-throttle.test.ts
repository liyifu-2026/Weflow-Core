/**
 * 登录限流器单元测试：注入时钟与存储，验证窗口内计数、锁定、
 * 成功清除与纯 IP 维度（用户名轮换防护）。
 */
import { describe, expect, it } from "vitest";
import {
  LoginThrottle,
  LoginThrottledError,
  type LoginThrottleStore,
} from "../modules/identity/application/login-throttle.js";

class MemoryStore implements LoginThrottleStore {
  readonly map = new Map<string, { failures: number[] }>();
  get(key: string) {
    return this.map.get(key);
  }
  set(key: string, record: { failures: number[] }) {
    this.map.set(key, record);
  }
  delete(key: string) {
    this.map.delete(key);
  }
  keys() {
    return [...this.map.keys()];
  }
}

describe("login throttle", () => {
  it("allows attempts below the failure threshold", () => {
    let now = 1_000_000;
    const throttle = new LoginThrottle({
      now: () => now,
      store: new MemoryStore(),
    });
    for (let i = 0; i < 9; i += 1) {
      throttle.recordFailure("10.0.0.1", "alice");
      now += 1;
      expect(() => throttle.assertAllowed("10.0.0.1", "alice")).not.toThrow();
    }
  });

  it("locks after threshold failures and reports retry-after", () => {
    let now = 1_000_000;
    const throttle = new LoginThrottle({
      now: () => now,
      store: new MemoryStore(),
    });
    for (let i = 0; i < 10; i += 1) throttle.recordFailure("10.0.0.1", "alice");
    now += 60_000;
    try {
      throttle.assertAllowed("10.0.0.1", "alice");
      expect.unreachable("expected LoginThrottledError");
    } catch (error) {
      expect(error).toBeInstanceOf(LoginThrottledError);
      const retryAfter = (error as LoginThrottledError).retryAfterSeconds;
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    }
  });

  it("blocks username rotation from the same IP", () => {
    let now = 2_000_000;
    const throttle = new LoginThrottle({
      now: () => now,
      store: new MemoryStore(),
    });
    // alice 换 bob 轮换：pair 键各自不满，纯 IP 键累计超限
    for (let i = 0; i < 10; i += 1) {
      throttle.recordFailure("10.0.0.2", `user${String(i)}`);
      now += 1;
    }
    now += 1;
    expect(() => throttle.assertAllowed("10.0.0.2", "another")).toThrow(
      LoginThrottledError,
    );
  });

  it("releases the lock once the window slides past the failures", () => {
    let now = 3_000_000;
    const throttle = new LoginThrottle({
      now: () => now,
      store: new MemoryStore(),
    });
    for (let i = 0; i < 10; i += 1) throttle.recordFailure("10.0.0.3", "carol");
    now += 15 * 60 * 1_000 + 1;
    expect(() => throttle.assertAllowed("10.0.0.3", "carol")).not.toThrow();
  });

  it("clears pair counter on success but keeps the pure-IP counter", () => {
    const now = 4_000_000;
    const throttle = new LoginThrottle({
      now: () => now,
      store: new MemoryStore(),
    });
    for (let i = 0; i < 9; i += 1) throttle.recordFailure("10.0.0.4", "dave");
    throttle.recordSuccess("10.0.0.4", "dave");
    // pair 计数清零 → 9 次纯 IP 记录仍不足以锁定
    expect(() => throttle.assertAllowed("10.0.0.4", "dave")).not.toThrow();
    // 但同一 IP 下新用户名再失败 1 次 → 纯 IP 累计 10 次 → 锁定
    throttle.recordFailure("10.0.0.4", "mallory");
    expect(() => throttle.assertAllowed("10.0.0.4", "mallory")).toThrow(
      LoginThrottledError,
    );
  });

  it("caps stored keys to bound memory under forged source IPs", () => {
    const store = new MemoryStore();
    let now = 5_000_000;
    const throttle = new LoginThrottle({ now: () => now, store });
    for (let i = 0; i < 10_500; i += 1) {
      throttle.recordFailure(`10.1.${String(i)}`, "x");
      now += 1;
    }
    expect(store.keys().length).toBeLessThanOrEqual(10_000);
  });
});
