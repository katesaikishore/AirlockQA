import { expect, test } from '@playwright/test';

/**
 * Seeded flaky suite for the attach/flake demo. No browser page is used, so the demo is fast and
 * deterministic; FLAKE_ROUND makes exactly one test fail per round so `airlock flake` can find it.
 */
const round = process.env.FLAKE_ROUND || '1';

test('cart fixture returns totals', async () => {
  if (round === '1') {
    throw new Error('net::ERR_CONNECTION_REFUSED request failed GET https://shop.example.test/api/cart');
  }
  expect(2 + 2).toBe(4);
});

test('login selector exists', async () => {
  if (round === '2') {
    throw new Error('locator.waitFor: Timeout 30000ms exceeded.\nwaiting for selector "#login"');
  }
  expect(true).toBe(true);
});

test('pricing copy is stable', async () => {
  expect('Free plan').toContain('Free');
});

test('slow recommendations endpoint', async () => {
  if (round === '3') {
    throw new Error('Test timeout of 30000ms exceeded.');
  }
  expect(1).toBe(1);
});

test('known checkout total mismatch', async () => {
  throw new Error('expect(received).toBe(expected)\nExpected: 42\nReceived: 41');
});
