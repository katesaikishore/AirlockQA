import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 15_000,
  retries: 0,
  reporter: 'json',
  use: { headless: true },
});
