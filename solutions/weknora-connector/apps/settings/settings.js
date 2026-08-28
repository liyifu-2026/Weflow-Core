/**
 * WeKnora Connector 配置页（业务 UI，经 Console ExtensionHost 加载）。
 *
 * 只负责 WeKnora 对接参数的配置界面（Base URL / API Key / 知识库白名单 /
 * 超时），通过 Core 的通用扩展设置路由读写。WeKnora 自身的知识库前端
 * 由 WeKnora 自带 UI 提供（kb.leaif.com），本页不实现知识库界面。
 */
const SOLUTION_ID = "weflow.weknora-connector";
const EXTENSION_ID = "weknora-connector-settings";
const SETTINGS_URL = `/api/v1/admin/solutions/${SOLUTION_ID}/extensions/${EXTENSION_ID}/settings`;

const FIELDS = [
  { key: "weknora_base_url", label: "WeKnora Base URL", type: "text", default: "http://127.0.0.1:8080/api/v1" },
  { key: "weknora_api_key", label: "WeKnora API Key", type: "secret", default: "" },
  { key: "weknora_knowledge_base_ids", label: "知识库白名单（逗号分隔，留空=全部）", type: "text", default: "" },
  { key: "weknora_timeout_ms", label: "请求超时（毫秒）", type: "number", default: "15000" },
];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === "string") node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

function mount(container) {
  container.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = `
    .wk-form { font-family: system-ui, sans-serif; max-width: 560px; padding: 20px; color: #1f2937; }
    .wk-form h2 { font-size: 18px; margin: 0 0 4px; }
    .wk-form p.desc { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
    .wk-field { margin-bottom: 14px; }
    .wk-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; }
    .wk-field input { width: 100%; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
    .wk-actions { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
    .wk-btn { padding: 8px 16px; border-radius: 6px; border: none; font-size: 14px; cursor: pointer; }
    .wk-btn-primary { background: #2563eb; color: #fff; }
    .wk-btn-primary:hover { background: #1d4ed8; }
    .wk-status { font-size: 13px; }
    .wk-status.ok { color: #16a34a; }
    .wk-status.err { color: #dc2626; }
    .wk-health { margin-top: 16px; padding: 10px 12px; border-radius: 6px; background: #f3f4f6; font-size: 13px; }
  `;
  container.appendChild(style);

  const root = el("div", { class: "wk-form" }, [
    el("h2", {}, ["WeKnora 知识库对接配置"]),
    el("p", { class: "desc" }, [
      "配置平台与唯一外部知识库 WeKnora 的连接参数。知识库内容管理请使用 WeKnora 自带前端（kb.leaif.com）。",
    ]),
  ]);
  const inputs = {};
  for (const field of FIELDS) {
    const input = el("input", { type: field.type === "secret" ? "password" : field.type === "number" ? "number" : "text", placeholder: field.default });
    inputs[field.key] = input;
    root.appendChild(
      el("div", { class: "wk-field" }, [
        el("label", { for: field.key }, [field.label]),
        input,
      ]),
    );
  }

  const status = el("div", { class: "wk-status" });
  const saveBtn = el("button", { class: "wk-btn wk-btn-primary" }, ["保存配置"]);
  const health = el("div", { class: "wk-health" }, ["健康检查：未检测"]);
  root.appendChild(
    el("div", { class: "wk-actions" }, [saveBtn, status]),
  );
  root.appendChild(health);
  container.appendChild(root);

  async function load() {
    try {
      const response = await fetch(SETTINGS_URL, { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      const settings = data.settings ?? {};
      for (const field of FIELDS) {
        inputs[field.key].value = settings[field.key] ?? field.default ?? "";
      }
    } catch {
      // 未安装/无权限时保留默认值
    }
  }

  saveBtn.addEventListener("click", async () => {
    const settings = {};
    for (const field of FIELDS) settings[field.key] = inputs[field.key].value.trim();
    try {
      const response = await fetch(SETTINGS_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ settings }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      status.textContent = "已保存 ✓";
      status.className = "wk-status ok";
    } catch (error) {
      status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
      status.className = "wk-status err";
    }
  });

  async function checkHealth() {
    try {
      const response = await fetch("/api/v1/system/status", { credentials: "include" });
      const data = await response.json().catch(() => ({}));
      const knowledge = data.knowledge;
      if (knowledge && knowledge.status === "healthy") {
        health.textContent = "健康检查：WeKnora 可达 ✓";
      } else if (knowledge && knowledge.status === "not_configured") {
        health.textContent = "健康检查：WeKnora 未配置（平台未注入 API Key）";
      } else {
        health.textContent = `健康检查：${JSON.stringify(knowledge ?? data)}`;
      }
    } catch {
      health.textContent = "健康检查：系统状态接口不可达";
    }
  }

  void load();
  void checkHealth();
  return {
    unmount() {
      container.innerHTML = "";
    },
  };
}

export { mount };
export default { mount };
