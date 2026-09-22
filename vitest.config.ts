import { defineConfig } from "vitest/config"

// biome-ignore lint/style/noDefaultExport: vitest requires a default export
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
})
