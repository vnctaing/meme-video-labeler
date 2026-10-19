import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    timeout: 180_000,
    url: "http://localhost:4173/",
    reuseExistingServer: false,
  },
  use: {
    baseURL: "http://localhost:4173/",
    channel: process.env.PW_CHANNEL,
    acceptDownloads: true,
  },
});
