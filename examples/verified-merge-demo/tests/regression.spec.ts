import { test, expect } from '@playwright/test';

test('reproduced regression', () => {
  expect('cart total').toBe('the total the store never shows');
});
