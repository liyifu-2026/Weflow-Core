/**
 * 运行外壳识别与「桌面壳默认值」。
 *
 * 产品页被桌面壳（Tauri）装进窗口时，壳会在跳转地址上带 `?shell=desktop`
 * （见 apps/desktop/src-tauri/ui/index.html 连接页）。
 *
 * 注意：这个参数**只在启动那一刻可靠**——登录重定向、SPA 路由都会把它丢掉
 * （实测：登录成功后 URL 变成 /conversations?id=…）。所以必须在这里启动时就
 * 把「桌面壳的默认值」落成普通用户偏好；之后（含刷新）都按偏好走。
 *
 * 只落偏好、不落外壳身份：即使有人手动带参数在浏览器里打开，也只是多了一条
 * 用户看得见、改得动的偏好，不会让这个浏览器永久被当成桌面端。
 */

/** 本次加载是否来自桌面壳 */
export function isDesktopShell(): boolean {
  try {
    const shell = new URLSearchParams(window.location.search).get("shell");
    if (shell === "desktop") return true;
    const globals = window as unknown as Record<string, unknown>;
    return Boolean(globals.__TAURI__ || globals.__TAURI_INTERNALS__);
  } catch {
    return false;
  }
}

/** 右侧上下文检查器的偏好键（与 use-conversation-inspector 共用） */
const INSPECTOR_PREF_KEY = "wf-inspector";

/**
 * 入口处调用一次：桌面壳首次进入时，把右侧上下文检查器默认设为「收起」
 * ——桌面窗口宽度有限，聊天区优先。用户手动展开一次即写回 "open"，不再被覆盖。
 */
export function applyDesktopShellDefaults(): void {
  try {
    if (localStorage.getItem(INSPECTOR_PREF_KEY)) return;
    if (!isDesktopShell()) return;
    localStorage.setItem(INSPECTOR_PREF_KEY, "collapsed");
  } catch {
    // localStorage 不可用（隐私模式等）时按浏览器默认行为处理
  }
}
