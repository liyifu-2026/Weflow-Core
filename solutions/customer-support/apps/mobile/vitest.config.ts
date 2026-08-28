import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** vitest 别名与 tsconfig paths 对齐（@/* → ./src/*） */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
