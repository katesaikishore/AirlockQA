import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';

// Deliberately fails once, then passes. Verified Merge must call this a flake, never a regression.
test('unstable check', () => {
  const marker = '/tmp/airlock-flake-marker-demo';
  if (fs.existsSync(marker)) {
    expect(1 + 1).toBe(2);
    return;
  }
  fs.writeFileSync(marker, 'seen');
  expect(1 + 1).toBe(3);
});
