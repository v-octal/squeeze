import { defineConfig } from '@playwright/test'

const port = Number(process.env.PORT || process.env.PASEO_PORT || 5173)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 2,
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.CI ? undefined : 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
})
