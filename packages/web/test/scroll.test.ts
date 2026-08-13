import { describe, expect, test } from 'bun:test';
import { easeOut, offTarget, tweenScrollTop } from '../src/lib/scroll.ts';

const box = (scrollTop: number, scrollHeight: number) => ({
  scrollTop,
  scrollHeight,
  clientHeight: 600,
});

describe('offTarget', () => {
  test('a document already at the remembered offset is left alone', () => {
    expect(offTarget(box(800, 4000), 800)).toBe(false);
  });

  test('a document scrolled back to the top by its own load is nudged', () => {
    expect(offTarget(box(0, 4000), 800)).toBe(true);
  });

  test('the top is never a target worth chasing', () => {
    expect(offTarget(box(400, 4000), 0)).toBe(false);
  });

  test('content still too short to reach the offset keeps being nudged', () => {
    expect(offTarget(box(0, 900), 800)).toBe(true);
  });

  test('a document that ends before the offset settles at its own end', () => {
    expect(offTarget(box(300, 900), 800)).toBe(false);
  });

  test('sub-pixel offsets count as arrived', () => {
    expect(offTarget(box(799.5, 4000), 800)).toBe(false);
  });
});

describe('tweenScrollTop', () => {
  test('starts where it was and lands exactly on the target', () => {
    expect(tweenScrollTop(0, 4000, 0, 180)).toBe(0);
    expect(tweenScrollTop(0, 4000, 180, 180)).toBe(4000);
    expect(tweenScrollTop(0, 4000, 900, 180)).toBe(4000);
  });

  test('eases out: most of the distance is covered early', () => {
    expect(tweenScrollTop(0, 1000, 90, 180)).toBeGreaterThan(500);
  });

  test('the same fraction of time covers the same fraction of any distance', () => {
    const near = tweenScrollTop(0, 100, 60, 180) / 100;
    const far = tweenScrollTop(0, 100000, 60, 180) / 100000;
    expect(Math.abs(near - far)).toBeLessThan(1e-9);
  });

  test('scrolling upwards works the same way', () => {
    expect(tweenScrollTop(4000, 0, 180, 180)).toBe(0);
    expect(tweenScrollTop(4000, 0, 90, 180)).toBeLessThan(2000);
  });

  test('easing is monotonic between its two fixed points', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});
