import { defineConfig } from '@playwright/test';

/**
 * A normal Playwright config. Nothing here imports Airlock: the attach command generates a wrapper
 * config in .airlock/ that appends the Airlock reporter to this config's existing reporters.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: [['line'], ['./reporters/demo-reporter.ts']],
  // The demo starts its local store for recording; replay runs must not depend on it.
  webServer:
    process.env.AIRLOCK_ATTACH_NETWORK === 'replay'
      ? undefined
      : {
          command: 'bun ../demo-store/server.ts',
          cwd: '.',
          url: 'http://127.0.0.1:3900',
          reuseExistingServer: true,
          timeout: 15000,
        },
  use: {
    trace: 'off',
    storageState: './auth/state.json',
    launchOptions: process.env.AIRLOCK_CHROME_PATH ? { executablePath: process.env.AIRLOCK_CHROME_PATH } : undefined,
  },
});
