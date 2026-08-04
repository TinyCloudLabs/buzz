import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: ["**/smoke.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "openkey-nostr",
      testMatch: ["**/openkey-nostr.spec.ts"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: true,
        baseURL: process.env.BUZZ_WEB_URL ?? "http://localhost:3000",
      },
    },
  ],
  webServer: process.env.BUZZ_E2E_DOCKER
    ? undefined
    : {
        command: "pnpm exec vite preview --port 4173 --strictPort --host 127.0.0.1",
        cwd: ".",
        reuseExistingServer: !process.env.CI,
        url: "http://127.0.0.1:4173",
      },
});
