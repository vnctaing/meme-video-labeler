import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  server: { proxy: { "/api": `http://127.0.0.1:${process.env.AUTHOR_API_PORT ?? "8787"}` } },
  preview: { proxy: {} },
  build: { chunkSizeWarningLimit: 600 },
  test: { include: ["src/**/*.test.ts"] },
});
