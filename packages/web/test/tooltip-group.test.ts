import { describe, expect, test } from 'bun:test';
import {
  hoverDelay,
  TOOLTIP_DELAY,
  WARM_GRACE,
  type WarmState,
} from '../src/lib/tooltip-group.ts';

const cold: WarmState = { showing: false, hiddenAt: null };

describe('hoverDelay', () => {
  test('the first hover of the session waits', () => {
    expect(hoverDelay(cold, 10_000)).toBe(TOOLTIP_DELAY);
    expect(TOOLTIP_DELAY).toBe(500);
  });

  test('a neighbour opens instantly while one is still on screen', () => {
    expect(hoverDelay({ showing: true, hiddenAt: null }, 10_000)).toBe(0);
  });

  test('and still instantly just after it came down', () => {
    expect(hoverDelay({ showing: false, hiddenAt: 10_000 }, 10_000 + WARM_GRACE - 1)).toBe(0);
  });

  test('the group goes cold again once the grace period is up', () => {
    expect(hoverDelay({ showing: false, hiddenAt: 10_000 }, 10_000 + WARM_GRACE)).toBe(
      TOOLTIP_DELAY
    );
    expect(hoverDelay({ showing: false, hiddenAt: 10_000 }, 30_000)).toBe(TOOLTIP_DELAY);
  });

  test('showing outranks a stale hidden timestamp', () => {
    expect(hoverDelay({ showing: true, hiddenAt: 0 }, 30_000)).toBe(0);
  });

  test('the two durations are configurable together', () => {
    expect(hoverDelay(cold, 0, 250, 50)).toBe(250);
    expect(hoverDelay({ showing: false, hiddenAt: 100 }, 120, 250, 50)).toBe(0);
    expect(hoverDelay({ showing: false, hiddenAt: 100 }, 180, 250, 50)).toBe(250);
  });
});
