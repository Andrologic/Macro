import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sourceFingerprint, stageVerifiedBinary } from './native-sqlite';

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


test('rejects a cache replacement between build and copy, accepts only this invocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'macro-native-stage-test-'));
  try {
    const source = join(root, 'shared-binary');
    const staged = join(root, 'private-binary');
    const expected = { sourceSha256: 'source-A', buildNonce: 'build-A' };
    const readIdentity = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(source, JSON.stringify(expected));
    // A's build finished. B replaces the shared executable before A's copy.
    writeFileSync(source, JSON.stringify({ sourceSha256: 'source-B', buildNonce: 'build-B' }));
    expect(() => stageVerifiedBinary(source, staged, expected, readIdentity)).toThrow('identity mismatch');
    // Even another build of identical sources must not be attributed to A.
    writeFileSync(source, JSON.stringify({ ...expected, buildNonce: 'build-B' }));
    expect(() => stageVerifiedBinary(source, staged, expected, readIdentity)).toThrow('identity mismatch');
    writeFileSync(source, JSON.stringify(expected));
    stageVerifiedBinary(source, staged, expected, readIdentity);
    writeFileSync(source, JSON.stringify({ sourceSha256: 'later', buildNonce: 'later' }));
    expect(readIdentity(staged)).toEqual(expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
