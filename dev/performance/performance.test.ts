import { describe, expect, it } from 'bun:test';
import { distribution } from './stats';
import { installNativeProbe } from './native-probe';
import { productSql, sqliteBaseline } from './sqlite';

describe('performance measurement validity', () => {
  it('uses nearest rank and rejects missing/nonfinite observations', () => {
    expect(distribution(Array.from({ length: 100 }, (_, i) => 100 - i))).toEqual({ count: 100, p50: 50, p95: 95, max: 100 });
    for (const values of [[], [NaN], [-1], [Infinity]]) expect(() => distribution(values)).toThrow();
  });
  it('preserves transport return, error, receiver and restores original invoke', async () => {
    const error = new Error('synthetic');
    const bridge = { async invoke(command: string) {
      expect(this).toBe(bridge);
      if (command === 'fail') throw error;
      return { value: 'é' };
    } };
    const original = bridge.invoke;
    const probe = installNativeProbe(bridge, true);
    const sample = await probe.measure(async () => {
      expect(await bridge.invoke('workspace_architect_invalidate')).toEqual({ value: 'é' });
      await expect(bridge.invoke('fail')).rejects.toBe(error);
    });
    expect(sample.invalidationCalls).toBe(1);
    expect(sample.calls[0].responseJsonBytes).toBe(14);
    expect(sample.calls[1].failed).toBe(true);
    probe.uninstall();
    expect(bridge.invoke).toBe(original);
  });
  it('rejects overlapping actions and unfinished IPC samples', async () => {
    let resolve!: () => void;
    const bridge = { invoke: () => new Promise<void>((done) => { resolve = done; }) };
    const probe = installNativeProbe(bridge, true);
    let pending!: Promise<unknown>;
    await expect(probe.measure(async () => {
      pending = bridge.invoke();
      await expect(probe.measure(async () => {})).rejects.toThrow();
    })).rejects.toThrow('IPC still pending');
    expect(() => probe.uninstall()).toThrow();
    await expect(probe.measure(async () => {})).rejects.toThrow();
    resolve();
    await pending;
    probe.uninstall();
  });
  it('loads current product SQL and executes it on the canonical schema', () => {
    expect(productSql('list_messages')).toContain('ORDER BY created_at ASC, id ASC');
    expect(() => productSql('missing')).toThrow();
    expect(sqliteBaseline(3).read.count).toBe(100);
  });
});
