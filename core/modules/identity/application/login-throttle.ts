/**
 * 登录限流器（application 层）：失败尝试滑动窗计数 + 超限锁定。
 *
 * 维度：用户名 与 全局 双计数——只按 IP 计在 frpc TCP 隧道部署下失效
 * （所有公网请求经隧道转发后 request.ip 恒为 127.0.0.1，纯 IP 桶成了
 * 全站共享一把锁：任何人 10 次失败即可把全体用户锁死 15 分钟并可无限
 * 续锁，审计 sourceIp 也全部失真）。改为以用户名为主维度（对已知账号
 * 的定向爆破仍被 10 次/15 分钟挡住），全局桶作分布式撒网兜底。
 * 产品是单进程部署（CONTEXT.md），内存态即全量状态；时钟与容量可注入，
 * 便于测试与未来外置存储。锁定期间直接拒绝，不做 Argon2 校验，
 * 同时挡住暴力破解与密码哈希算力消耗。
 * 横向扩容注意：内存态意味着重启即清零、多实例各算各的；若 api 进程
 * 未来多实例部署，用 LoginThrottleStore 接缝换 Redis 实现即可，调用方不变。
 */

/** 窗口内的失败尝试上限（用户名 与 全局 各自计） */
const MAX_FAILURES_PER_WINDOW = 10;
/** 全局兜底桶上限：远高于单账号限值，只拦分布式撒网 */
const MAX_GLOBAL_FAILURES_PER_WINDOW = 200;
/** 滑动窗口长度 */
const WINDOW_MS = 15 * 60 * 1_000;
/** 键总数上限：超限时丢弃最早记录，防内存被伪造输入撑爆 */
const MAX_KEYS = 10_000;

export class LoginThrottledError extends Error {
  public constructor(public readonly retryAfterSeconds: number) {
    super("too many login attempts");
    this.name = "LoginThrottledError";
  }
}

type FailureRecord = {
  /** 该键在窗口内的失败时间戳（升序） */
  failures: number[];
};

export interface LoginThrottleStore {
  get(key: string): FailureRecord | undefined;
  set(key: string, record: FailureRecord): void;
  delete(key: string): void;
  keys(): string[];
}

class InMemoryStore implements LoginThrottleStore {
  readonly #map = new Map<string, FailureRecord>();

  get(key: string): FailureRecord | undefined {
    return this.#map.get(key);
  }
  set(key: string, record: FailureRecord): void {
    this.#map.set(key, record);
  }
  delete(key: string): void {
    this.#map.delete(key);
  }
  keys(): string[] {
    return [...this.#map.keys()];
  }
}

export type LoginThrottleInput = {
  now?: () => number;
  store?: LoginThrottleStore;
};

export class LoginThrottle {
  readonly #now: () => number;
  readonly #store: LoginThrottleStore;

  constructor(input: LoginThrottleInput = {}) {
    this.#now = input.now ?? Date.now;
    this.#store = input.store ?? new InMemoryStore();
  }

  /** 尝试前检查：锁定中抛 LoginThrottledError（含建议 Retry-After） */
  assertAllowed(sourceIp: string, username: string): void {
    this.#prune();
    const cutoff = this.#now() - WINDOW_MS;
    for (const key of this.#keysFor(sourceIp, username)) {
      const record = this.#store.get(key);
      if (!record) continue;
      const max =
        key === globalKey()
          ? MAX_GLOBAL_FAILURES_PER_WINDOW
          : MAX_FAILURES_PER_WINDOW;
      const active = record.failures.filter((at) => at > cutoff);
      if (active.length >= max) {
        const oldest = Math.min(...active);
        throw new LoginThrottledError(
          Math.max(1, Math.ceil((oldest + WINDOW_MS - this.#now()) / 1_000)),
        );
      }
    }
  }

  /** 登录失败：记录用户名 + 全局 + IP 对（非回环时含纯 IP）计数 */
  recordFailure(sourceIp: string, username: string): void {
    const at = this.#now();
    for (const key of this.#keysFor(sourceIp, username)) {
      const record = this.#store.get(key) ?? { failures: [] };
      record.failures.push(at);
      this.#store.set(key, record);
    }
    this.#prune();
  }

  /** 登录成功：清除该用户名 与 IP+用户名 的计数（全局/纯 IP 桶保留，防轮换） */
  recordSuccess(sourceIp: string, username: string): void {
    this.#store.delete(usernameKey(username));
    this.#store.delete(pairKey(sourceIp, username));
  }

  /**
   * 计数键集：用户名（主维度）+ 全局兜底 + IP 对。
   * 回环源（frpc TCP 隧道下所有公网请求都是 127.0.0.1）跳过纯 IP 桶——
   * 否则它就是全站共享一把锁，任何人 10 次失败可锁死全体用户并无限续锁。
   * 非回环（本机直连/局域网）保留纯 IP 桶，用户名轮换防护不回退。
   */
  #keysFor(sourceIp: string, username: string): string[] {
    const keys = [usernameKey(username), globalKey(), pairKey(sourceIp, username)];
    if (!isLoopbackIp(sourceIp)) keys.push(ipKey(sourceIp));
    return keys;
  }

  /** 键数超限时整体修剪（防伪造输入撑爆内存） */
  #prune(): void {
    const keys = this.#store.keys();
    if (keys.length <= MAX_KEYS) return;
    for (const key of keys.slice(0, keys.length - MAX_KEYS)) {
      this.#store.delete(key);
    }
  }
}

function usernameKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

function pairKey(sourceIp: string, username: string): string {
  return `pair:${sourceIp}|${username}`;
}

function globalKey(): string {
  return "global";
}

function ipKey(sourceIp: string): string {
  return `ip:${sourceIp}`;
}

function isLoopbackIp(sourceIp: string): boolean {
  return (
    sourceIp === "127.0.0.1" ||
    sourceIp === "::1" ||
    sourceIp === "::ffff:127.0.0.1" ||
    sourceIp.startsWith("127.")
  );
}
