import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, retries: 0, workers: 1,
  use: { baseURL: process.env.E2E_BASE || 'http://localhost:8090', channel: 'chrome', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: { command: 'node --env-file-if-exists=.env tests/e2e/server.js', url: 'http://localhost:8090/api/health', reuseExistingServer: false, timeout: 60000 },
});
