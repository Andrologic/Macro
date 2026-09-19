import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceFingerprint } from './native-sqlite';

test('native fingerprint detects untracked and tracked source changes, excludes Cargo outputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'macro-native-provenance-'));
  try {
    execFileSync('git', ['init', '--template='], { cwd: root, stdio: 'ignore' });
    mkdirSync(join(root, 'src-tauri/target'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'src-tauri/target/\n');
    writeFileSync(join(root, 'src-tauri/source.rs'), 'first');
    const first = sourceFingerprint(root);
    writeFileSync(join(root, 'src-tauri/source.rs'), 'second');
    expect(sourceFingerprint(root)).not.toBe(first);
    execFileSync('git', ['add', '.'], { cwd: root });
    const staged = sourceFingerprint(root);
    writeFileSync(join(root, 'src-tauri/target/output'), 'build');
    expect(sourceFingerprint(root)).toBe(staged);
    writeFileSync(join(root, 'src-tauri/new.rs'), 'new untracked source');
    expect(sourceFingerprint(root)).not.toBe(staged);
    rmSync(join(root, 'src-tauri/new.rs'));
    expect(sourceFingerprint(root)).toBe(staged);
    writeFileSync(join(root, 'src-tauri/source.rs'), 'changed tracked source');
    expect(sourceFingerprint(root)).not.toBe(staged);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
