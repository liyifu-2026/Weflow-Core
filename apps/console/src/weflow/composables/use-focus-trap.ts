import {
  nextTick,
  onMounted,
  onUnmounted,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";

type MaybeRef<T> = Ref<T> | ComputedRef<T>;

function focusables(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

/**
 * 打开时把焦点移入浮层并圈定 Tab；关闭时把焦点还给触发元素。
 */
export function useFocusTrap(
  container: Ref<HTMLElement | null>,
  open: MaybeRef<boolean>,
) {
  let restore: HTMLElement | null = null;

  function onKeydown(event: KeyboardEvent) {
    if (!open.value || event.key !== "Tab") return;
    const root = container.value;
    if (!root) return;
    const list = focusables(root);
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  watch(open, (value) => {
    if (value) {
      restore = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      void nextTick(() => {
        const root = container.value;
        const list = root ? focusables(root) : [];
        const initial =
          list.find((el) => el.matches("input, select, textarea")) ?? list[0];
        (initial ?? root)?.focus?.();
      });
    } else if (restore) {
      restore.focus?.();
      restore = null;
    }
  });

  onMounted(() => document.addEventListener("keydown", onKeydown, true));
  onUnmounted(() => document.removeEventListener("keydown", onKeydown, true));
}
