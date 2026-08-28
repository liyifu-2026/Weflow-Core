/**
 * Minimal overlay keyboard behavior: Esc closes, focus returns to the
 * element that opened the overlay. Each overlay registers its own instance;
 * the listener is attached only while the overlay is open.
 */
import { onUnmounted, watch, type Ref } from "vue";

export function useEscClose(active: Ref<boolean>, onClose: () => void) {
  let lastFocused: HTMLElement | null = null;

  function handler(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  watch(active, (open) => {
    if (open) {
      lastFocused =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      window.addEventListener("keydown", handler);
    } else {
      window.removeEventListener("keydown", handler);
      if (lastFocused && document.contains(lastFocused)) {
        lastFocused.focus();
      }
    }
  });

  onUnmounted(() => window.removeEventListener("keydown", handler));
}

