/**
 * 转录滚动跟随（Transcript Scroll）。
 *
 * 「在底部自动跟随新消息、离开底部累计未读」的机制与切会话锚定：
 * 距底 ≤72px 视为在底部；新消息落地后瞬时滚动 + rAF/延时二次校正
 * （气泡内头像/图片异步加载会改变 scrollHeight，smooth 动画会半路打断）。
 * 加载更早消息时用「首条可见消息」作锚，prepend 后恢复相对位置。
 */
import { ref, type Ref } from "vue";

/** 距底 ≤72px 视为“在底部” */
const AT_BOTTOM_THRESHOLD_PX = 72;

export function firstVisibleMessageId(pane: HTMLElement): string | null {
  const rows = pane.querySelectorAll<HTMLElement>("[id^='message-']");
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    if (rect.bottom >= paneRect.top && rect.top <= paneRect.bottom) {
      return row.id.replace(/^message-/, "");
    }
  }
  return null;
}

export function restoreAnchor(
  pane: HTMLElement | null,
  anchorId: string | null,
  anchorTop: number,
): void {
  if (!pane || !anchorId) {
    pane?.scrollTo({ top: 0 });
    return;
  }
  const el = document.getElementById(`message-${anchorId}`);
  if (el) {
    // 保持锚点消息在视口中的相对位置（prepend 后 offsetTop 变大）
    const relative = anchorTop - el.offsetTop;
    pane.scrollTop = el.offsetTop + relative;
  } else {
    pane.scrollTo({ top: 0 });
  }
}

export type UseTranscriptScroll = ReturnType<typeof useTranscriptScroll>;

export function useTranscriptScroll(options: {
  /** 工作区 store 会话（跨登录记忆滚动位置） */
  workspace: { scrollTop: number };
  /** 当前会话整页重载（未读点「回最新」时的行为） */
  onReloadCurrent: () => Promise<void> | void;
}) {
  const { workspace } = options;

  const pane = ref<HTMLElement | null>(null);
  const atBottom = ref(true);
  const newMessageCount = ref(0);

  /** 切会话重置跟随状态：否则上一个会话的「不在底部」会泄漏到新会话，
   * 新消息只累加角标、正文不追加，角标计数也会串台。 */
  function resetFollowState(): void {
    atBottom.value = true;
    newMessageCount.value = 0;
  }

  function rememberScroll(): void {
    workspace.scrollTop = pane.value?.scrollTop ?? 0;
  }

  function onMessagesScroll(): void {
    const el = pane.value;
    if (!el) return;
    atBottom.value =
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
    workspace.scrollTop = el.scrollTop;
  }

  // 滚到最新消息：瞬时滚动 + rAF/延时二次校正。
  // 气泡内头像、图片是异步加载的，落地后会改变 scrollHeight；
  // 若用 smooth 动画，中途布局变化会直接打断动画，导致停在半路。
  function scrollToLatest(guard?: () => boolean): void {
    const go = () => {
      const el = pane.value;
      if (el && (!guard || guard())) el.scrollTo({ top: el.scrollHeight });
    };
    go();
    requestAnimationFrame(go);
    window.setTimeout(go, 150);
  }

  /** 深链接定位：按 messageId 滚到对应消息（找不到时不动） */
  function scrollToMessage(messageId: string): boolean {
    const target = document.getElementById(`message-${messageId}`);
    if (!target) return false;
    target.scrollIntoView({ block: "center" });
    return true;
  }

  /** 未读角标「回最新」：有未读 → 整页重载当前会话；否则滚到底。 */
  async function jumpToLatest(): Promise<void> {
    const hadNew = newMessageCount.value > 0;
    newMessageCount.value = 0;
    if (hadNew) {
      await options.onReloadCurrent();
    } else {
      scrollToLatest();
    }
  }

  return {
    pane: pane as Ref<HTMLElement | null>,
    atBottom: atBottom as Ref<boolean>,
    newMessageCount: newMessageCount as Ref<number>,
    resetFollowState,
    rememberScroll,
    onMessagesScroll,
    scrollToLatest,
    scrollToMessage,
    jumpToLatest,
  };
}
