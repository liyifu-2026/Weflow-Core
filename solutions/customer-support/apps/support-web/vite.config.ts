import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const CORE_API_TARGET = process.env.CORE_API_TARGET || "http://127.0.0.1:3100";

// support-web 是产品本体 SPA（自带登录与布局），不再是 Console 的微前端
// bundle —— 因此走常规 app 构建（index.html 入口），而不是 lib 模式。
export default defineConfig({
  base: "/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    sourcemap: true,
  },
  server: {
    port: 5174,
    host: true,
    cors: true,
    // frpc 隧道公网入口（web.leaif.com → 本机 5174）需要显式放行
    allowedHosts: ["web.leaif.com", "localhost", ".leaif.com"],
    proxy: {
      "/api": {
        target: CORE_API_TARGET,
        changeOrigin: true,
        secure: false,
      },
      "/customer-support": {
        target: CORE_API_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  preview: {
    port: 4174,
    host: true,
    proxy: {
      "/api": {
        target: CORE_API_TARGET,
        changeOrigin: true,
        secure: false,
      },
      "/customer-support": {
        target: CORE_API_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
