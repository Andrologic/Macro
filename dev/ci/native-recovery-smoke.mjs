#!/usr/bin/env bun

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const NATIVE_RECOVERY_TESTS = Object.freeze([
  'app_updates::tests::atomic_write_replaces_the_previous_file',
  'app_updates::tests::atomic_write_keeps_the_previous_file_when_replacement_fails',
  'db::tests::create_pool_applies_agent_run_migration_to_existing_baseline',
  'local_backup::tests::startup_recovers_interrupted_restore_and_preserves_rollback_archive',
]);

function rustHost() {
  const result = spawnSync('rustc', ['--version', '--verbose'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('rustc is unavailable');
  const host = result.stdout.match(/^host:\s*(\S+)/m)?.[1];
  if (!host) throw new Error('rustc did not report its host target');
  return host;
}

function createMissingSidecarPlaceholders(host) {
  const directory = 'src-tauri/binaries';
  mkdirSync(directory, { recursive: true });
  return ['macro-ai-runtime', 'macro-extension-runtime'].flatMap((name) => {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const path = `${directory}/${name}-${host}${suffix}`;
    if (existsSync(path)) return [];
    writeFileSync(path, 'native-test-placeholder');
    return [path];
  });
}

export function runNativeRecoverySmoke() {
  const created = createMissingSidecarPlaceholders(rustHost());
  try {
    for (const testName of NATIVE_RECOVERY_TESTS) {
      console.log(`\n==> ${testName}`);
      const result = spawnSync('cargo', [
        'test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--lib', testName, '--', '--exact',
      ], { stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${testName} failed with exit code ${result.status ?? 'unknown'}`);
    }
  } finally {
    created.forEach((path) => unlinkSync(path));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { runNativeRecoverySmoke(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
