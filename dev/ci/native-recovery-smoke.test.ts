import { expect, test } from 'bun:test';
import { NATIVE_RECOVERY_TESTS } from './native-recovery-smoke.mjs';

test('pins one updater, migration, and recovery regression test', () => {
  expect(NATIVE_RECOVERY_TESTS).toHaveLength(3);
  expect(NATIVE_RECOVERY_TESTS.some((name) => name.startsWith('app_updates::'))).toBe(true);
  expect(NATIVE_RECOVERY_TESTS.some((name) => name.startsWith('db::'))).toBe(true);
  expect(NATIVE_RECOVERY_TESTS.some((name) => name.startsWith('local_backup::'))).toBe(true);
});
