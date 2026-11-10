import { expect, test } from '@playwright/test';

/**
 * Proves the attach determinism layer: the fixed clock is installed before navigation, and the page
 * document is served by the recorded network fixture on a replay run (webServer is disabled then).
 */
test('fixed clock and recorded page document', async ({ page }) => {
  await page.goto('http://127.0.0.1:3900/');
  await expect(page.locator('h1')).toContainText('Acme Cloud SaaS Store');
  expect(await page.evaluate(() => new Date().toISOString())).toBe('2026-01-01T00:00:00.000Z');
});
