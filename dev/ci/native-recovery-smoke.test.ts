import { expect, test } from 'bun:test';
import { NATIVE_RECOVERY_TESTS } from './native-recovery-smoke.mjs';

test('pins native updater success and failure, migration, and recovery regressions', () => {
  expect(NATIVE_RECOVERY_TESTS).toHaveLength(4);
  expect(NATIVE_RECOVERY_TESTS.filter((name) => name.startsWith('app_updates::'))).toHaveLength(2);
  expect(NATIVE_RECOVERY_TESTS.some((name) => name.startsWith('db::'))).toBe(true);
  expect(NATIVE_RECOVERY_TESTS.some((name) => name.startsWith('local_backup::'))).toBe(true);
});
