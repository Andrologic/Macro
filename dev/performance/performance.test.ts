import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertCleanBuildSource } from './build-provenance';
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
  it('does not evaluate accessors or custom serializers for byte counting', async () => {
    let reads = 0;
    let serializations = 0;
    const getterArgs = { get value() { return ++reads; } };
    const jsonArgs = { toJSON() { serializations++; return { value: serializations }; } };
    const bridge = { async invoke(_command: string, args?: unknown) { return JSON.stringify(args); } };
    const probe = installNativeProbe(bridge, true);
    const sample = await probe.measure(async () => {
      expect(await bridge.invoke('getter', getterArgs)).toBe('{"value":1}');
      expect(await bridge.invoke('serializer', jsonArgs)).toBe('{"value":1}');
      expect(await bridge.invoke('plain', { nested: ['é', null, 42] })).toBe('{"nested":["é",null,42]}');
    });
    expect(reads).toBe(1);
    expect(serializations).toBe(1);
    expect(sample.calls[0].requestJsonBytes).toBeNull();
    expect(sample.calls[1].requestJsonBytes).toBeNull();
    expect(sample.calls[2].requestJsonBytes).toBe(25);
    probe.uninstall();
  });
  it('requires all tracked/untracked build inputs clean and refuses ignored env files', () => {
    const root = mkdtempSync(join(tmpdir(), 'macro-provenance-test-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      git('init', '--template=');
      for (const file of ['index.html', 'postcss.config.js', 'tailwind.config.js']) {
        writeFileSync(join(root, file), 'synthetic');
      }
      writeFileSync(join(root, '.gitignore'), '.env.local\n');
      git('add', '.');
      git('-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic baseline');
      expect(assertCleanBuildSource(root)).toMatch(/^[a-f0-9]{40}$/);
      for (const file of ['index.html', 'postcss.config.js', 'tailwind.config.js']) {
        writeFileSync(join(root, file), 'changed');
        expect(() => assertCleanBuildSource(root)).toThrow('tracked and untracked');
        writeFileSync(join(root, file), 'synthetic');
      }
      writeFileSync(join(root, 'new-build-input.js'), 'synthetic');
      expect(() => assertCleanBuildSource(root)).toThrow('tracked and untracked');
      rmSync(join(root, 'new-build-input.js'));
      writeFileSync(join(root, '.env.local'), 'VITE_SYNTHETIC=1');
      expect(() => assertCleanBuildSource(root)).toThrow('Ignored environment');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('loads current product SQL and executes it on the canonical schema', () => {
    expect(productSql('list_messages')).toContain('ORDER BY created_at ASC, id ASC');
    expect(() => productSql('missing')).toThrow();
    expect(sqliteBaseline(3).read.count).toBe(100);
  });
});
