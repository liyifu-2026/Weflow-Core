/**
 * 账号退出模块
 * 封装退出登录的完整流程：通知 Core → 清除本地状态 → 跳转登录页。
 * 网络清理是 best effort：超时或失败不阻塞本地退出，跳转登录页必然发生。
 */
import type { MobileSession } from "./session";

/** 网络清理调用允许的最大等待时间（毫秒），避免弱网挂起锁死切换账号 */
const NETWORK_CLEANUP_TIMEOUT_MS = 5_000;

/** 退出登录所需的外部依赖，便于测试时注入 mock */
type SignOutDependencies = {
  logout(sessionToken: string): Promise<void>;
  revokeDevice?(): Promise<void>;
  clear(): Promise<void>;
  showSignIn(): void;
};

/** 给 Promise 增加超时：超时按失败处理，底层调用继续由系统完成（best effort） */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("network_cleanup_timeout")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

/**
 * 执行退出登录流程
 * 导航（showSignIn）放入 finally：无论网络、存储清理成败，用户都不会被锁在旧账号页面。
 */
export async function leaveAccount(
  session: MobileSession | undefined,
  dependencies: SignOutDependencies,
): Promise<void> {
  try {
    if (session && dependencies.revokeDevice) {
      try {
        await withTimeout(
          dependencies.revokeDevice(),
          NETWORK_CLEANUP_TIMEOUT_MS,
        );
      } catch {
        // Device revocation is best effort; local sign-out must remain available.
      }
    }
    if (session) {
      try {
        await withTimeout(
          dependencies.logout(session.sessionToken),
          NETWORK_CLEANUP_TIMEOUT_MS,
        );
      } catch {
        // Local sign-out must remain available when the session is already
        // revoked or the network is unavailable.
      }
    }
    try {
      await dependencies.clear();
    } catch {
      // Secure storage failures must not block navigation to sign-in.
    }
  } finally {
    dependencies.showSignIn();
  }
}
