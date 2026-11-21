import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ownedGroups, runningInGroups, stopProcesses } from './processes.mjs';

const linuxTest = test.skipIf(process.platform !== 'linux');
const spawnFixture = (directory: string, script: string) => {
  const child = spawn(process.execPath, ['-e', script], {
    cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH, HOME: directory },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', error => { throw error; });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
};
const kill = (pid: number | undefined) => {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};

linuxTest('finds a re-adopted descendant in another session without touching a foreign cwd', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'macro-recovery-owner-'));
  const foreignDirectory = mkdtempSync(path.join(tmpdir(), 'macro-recovery-foreign-'));
  const foreign = spawnFixture(foreignDirectory, 'setInterval(() => {}, 1000)');
  const root = spawnFixture(directory, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    process.stdout.write(String(child.pid) + '\\n', () => process.exit(23));
  `);
  let descendant: number | undefined;
  const lines = createInterface({ input: root.child.stdout! });
  try {
    let timer: ReturnType<typeof setTimeout>;
    descendant = await Promise.race([
      new Promise<number>(resolve => lines.once('line', line => resolve(Number(line)))),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No descendant PID')), 3000); }),
    ]).finally(() => clearTimeout(timer));
    expect((await root.exited).code).toBe(23);
    const groups = ownedGroups([root.child.pid!], directory);
    expect(groups).toContain(descendant);
    expect(groups).not.toContain(foreign.child.pid);
    const stopped = await stopProcesses([root.child.pid!], [root.exited], directory);
    expect(stopped.groups).toContain(descendant);
    expect(runningInGroups(stopped.groups)).toEqual([]);
    expect(runningInGroups([foreign.child.pid!])).toHaveLength(1);
  } finally {
    lines.close();
    kill(descendant); kill(root.child.pid); kill(foreign.child.pid);
    await Promise.all([root.exited, foreign.exited]);
    rmSync(directory, { recursive: true, force: true });
    rmSync(foreignDirectory, { recursive: true, force: true });
  }
}, 10_000);

linuxTest('kills and reaps the known root when process inventory fails', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'macro-recovery-inventory-'));
  const root = spawnFixture(directory, 'setInterval(() => {}, 1000)');
  try {
    await expect(stopProcesses([root.child.pid!], [root.exited], directory, () => { throw new Error('inventory unavailable'); }))
      .rejects.toThrow('inventory unavailable');
    expect((await root.exited).signal).toBe('SIGKILL');
    expect(runningInGroups([root.child.pid!])).toEqual([]);
  } finally {
    kill(root.child.pid);
    await root.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
