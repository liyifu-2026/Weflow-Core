import { ref } from "vue";
import { defineStore } from "pinia";
import type { NavigationOrigin } from "../navigation-context";

export const useNavigationContextStore = defineStore(
  "weflow-navigation-context",
  () => {
    const origin = ref<NavigationOrigin>({ type: "standalone" });
    function setOrigin(value: NavigationOrigin) {
      origin.value = value;
    }
    function clear() {
      origin.value = { type: "standalone" };
    }
    return { origin, setOrigin, clear };
  },
);

