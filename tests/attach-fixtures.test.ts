import { describe, expect, it } from 'bun:test';
import { DEFAULT_ATTACH_TIME, readDeterminismSettings } from '../src/testing/attach-fixtures.js';

describe('attach determinism settings', () => {
  it('defaults to clock fixed, network off and the documented epoch', () => {
    const settings = readDeterminismSettings({});
    expect(settings.clock).toBe('fixed');
    expect(settings.network).toBe('off');
    expect(settings.time).toBe(DEFAULT_ATTACH_TIME);
    expect(settings.dir).toBe('.airlock');
  });

  it('reads record/replay, clock opt-out, a custom instant and directory', () => {
    const settings = readDeterminismSettings({
      AIRLOCK_ATTACH_NETWORK: 'replay',
      AIRLOCK_ATTACH_CLOCK: 'off',
      AIRLOCK_ATTACH_TIME: '2025-06-01T12:00:00.000Z',
      AIRLOCK_ATTACH_DIR: 'tmp/airlock',
    });
    expect(settings).toEqual({
      network: 'replay',
      clock: 'off',
      time: '2025-06-01T12:00:00.000Z',
      dir: 'tmp/airlock',
    });
  });

  it('ignores invalid modes and instants instead of guessing', () => {
    const settings = readDeterminismSettings({ AIRLOCK_ATTACH_NETWORK: 'sometimes', AIRLOCK_ATTACH_TIME: 'not-a-date' });
    expect(settings.network).toBe('off');
    expect(settings.time).toBe(DEFAULT_ATTACH_TIME);
  });
});
