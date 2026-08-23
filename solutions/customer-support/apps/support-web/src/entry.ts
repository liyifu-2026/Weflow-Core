import { createApp } from "vue";
import App from "./App.vue";
import style from "./host.css?inline";

export function mount(container: HTMLElement) {
  if (!container) return;
  if (!container.ownerDocument.querySelector("style[data-weflow-support-web]")) {
    const el = container.ownerDocument.createElement("style");
    el.setAttribute("data-weflow-support-web", "");
    el.textContent = style;
    container.ownerDocument.head.appendChild(el);
  }
  const app = createApp(App);
  app.mount(container);
}

export default App;
