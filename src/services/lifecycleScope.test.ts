import { describe, expect, test } from 'bun:test';
import { createLifecycleScope } from './lifecycleScope';

describe('resource ownership', () => {
  test('releases once, including acquisitions delivered after stop', () => {
    const scope = createLifecycleScope();
    const released: string[] = [];
    const release = scope.own(() => released.push('early'));
    release();
    scope.stop();
    scope.stop();
    const late = scope.own(() => released.push('late'));
    late();
    expect(released).toEqual(['early', 'late']);
    expect(() => scope.assertActive()).toThrow();
  });
  test('drains admitted work after revocation without rolling it back', async () => {
    const scope = createLifecycleScope();
    let finish!: () => void;
    let settled = false;
    scope.track(new Promise<void>((resolve) => { finish = resolve; }));
    scope.stop();
    const draining = scope.drain().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await draining;
    expect(settled).toBe(true);
  });
  test('one faulty release does not retain the remaining resources', () => {
    const scope = createLifecycleScope();
    let released = false;
    scope.own(() => { released = true; });
    scope.own(() => { throw new Error('release failed'); });
    expect(() => scope.stop()).toThrow('Failed to release owned resources');
    expect(released).toBe(true);
    expect(scope.isActive()).toBe(false);
  });
});
