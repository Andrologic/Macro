import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { observeRun030, verifyNativeReplay030 } from './observe-run030';
import { cleanupObservedDatabases030, nativeDatabase } from './observe-run030.testSupport';

const directories: string[] = [];
afterEach(() => { cleanupObservedDatabases030(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function verifier(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'agsdl-replay-protocol-')); directories.push(directory);
  const path = join(directory, 'verifier.ts'); writeFileSync(path, body);
  return { directory, command: [process.execPath, path] };
}
test('passes positional arguments literally without a shell and returns the native verdict', () => {
  const stub = verifier('await Bun.write(process.argv[2],JSON.stringify(process.argv.slice(3)));process.stdout.write(JSON.stringify({ok:true,outsideReplay:["host"]}));');
  const log = join(stub.directory, 'argv.json'), database = 'db with spaces; $(no-shell)';
  expect(verifyNativeReplay030(database, 'system', 'invocation', { replayCommand: [...stub.command, log] })).toEqual({ ok: true, outsideReplay: ['host'] });
  expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual([database, 'system', 'invocation']);
});
test.each([
  ['nonzero exit with ok:true', 'process.stdout.write("{\\"ok\\":true}");process.exit(1);'],
  ['native divergence', 'process.stdout.write(JSON.stringify({ok:false,divergence:{eventId:"e",field:"state",expected:1,stored:2}}));process.exit(1);'],
  ['false verdict with zero exit', 'process.stdout.write("{\\"ok\\":false}");'],
  ['stderr only', 'process.stderr.write("failed");'],
  ['invalid JSON', 'process.stdout.write("not JSON");'],
  ['two JSON values', 'process.stdout.write("{}\\n{}");'],
  ['multiline JSON', 'process.stdout.write(JSON.stringify({ok:true},null,2));'],
  ['missing boolean', 'process.stdout.write("{\\"ok\\":1}");'],
  ['contradictory divergence', 'process.stdout.write("{\\"ok\\":true,\\"divergence\\":{}}");'],
  ['invalid outsideReplay', 'process.stdout.write("{\\"ok\\":true,\\"outsideReplay\\":false}");'],
] as const)('refuses %s before opening or projecting SQLite', (_name, body) => {
  const stub = verifier(body);
  expect(() => observeRun030(join(stub.directory, 'absent.sqlite'), 's', 'i', { replayCommand: stub.command })).toThrow(/native replay/i);
});
test('refuses a timeout, a missing executable and an empty command', () => {
  const stub = verifier('await new Promise(resolve=>setTimeout(resolve,3000));process.stdout.write("{\\"ok\\":true}");');
  expect(() => verifyNativeReplay030('db', 's', 'i', { replayCommand: stub.command, replayTimeoutMs: 5 })).toThrow('Native replay');
  expect(() => verifyNativeReplay030('db', 's', 'i', { replayCommand: [join(stub.directory, 'missing')] })).toThrow('Native replay');
  expect(() => verifyNativeReplay030('db', 's', 'i', { replayCommand: [] })).toThrow('required');
});
test('restricts replay bypass to explicitly marked synthetic unit databases', () => {
  const n = nativeDatabase(); n.start('worker'); expect(() => n.observe()).not.toThrow();
  n.plan.format = 'macro-agsdl-compiled-plan/2';
  expect(() => n.observe()).toThrow('restricted'); n.close();
});
test('kills the process group after a bounded grace when a wrapper ignores SIGTERM', () => {
  const stub = verifier(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['--eval','process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'],{stdio:'ignore'});
    writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));
    await Bun.sleep(1500);
    process.stdout.write(JSON.stringify({ok:true}));
  `);
  const log = join(stub.directory, 'pids.json'), started = performance.now();
  expect(() => verifyNativeReplay030('db', 's', 'i', { replayCommand: [...stub.command, log], replayTimeoutMs: 300 })).toThrow(/timeout/);
  expect(performance.now() - started).toBeLessThan(1300);
  const pids: number[] = JSON.parse(readFileSync(log, 'utf8'));
  for (const pid of pids) {
    const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    expect(status.status !== 0 || status.stdout.trim().startsWith('Z')).toBe(true);
  }
});
test('ignores an ok:true printed before the deadline when its process stays alive beyond it', () => {
  const stub = verifier('process.on("SIGTERM",()=>{});process.stdout.write(JSON.stringify({ok:true}));await Bun.sleep(1500);');
  expect(() => verifyNativeReplay030('db', 's', 'i', { replayCommand: stub.command, replayTimeoutMs: 150 })).toThrow(/timeout/);
});
