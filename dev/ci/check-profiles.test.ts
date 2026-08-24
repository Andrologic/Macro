import { describe, expect, test } from 'bun:test';
import { profileForClassification, stepsForProfile } from './check-profiles.mjs';

const names = (profile: string, platform = 'linux') =>
  stepsForProfile(profile, { platform }).map((entry) => entry.name);

describe('local CI profiles', () => {
  test('documentation checks stay lightweight', () => {
    expect(names('documentation')).toEqual([
      'Check version manifests',
      'Reject generated binaries',
      'Check Tauri updater configuration',
    ]);
  });

  test('native checks include frontend and Rust validation', () => {
    const checks = names('native');
    expect(checks).toContain('Run frontend tests');
    expect(checks).toContain('Run locked Rust tests for all targets');
    expect(checks).toContain('Run locked Rust doc tests');
    expect(checks).not.toContain('Check all Windows native targets');
  });

  test('full profiles test every native target once on every platform', () => {
    for (const platform of ['linux', 'win32']) {
      const steps = stepsForProfile('full', { platform });
      const rustTests = steps.find((entry) => entry.name === 'Run locked Rust tests for all targets');
      expect(rustTests?.args).toContain('--all-targets');
      expect(steps.filter((entry) => entry.name === 'Check all Windows native targets')).toHaveLength(0);
    }
  });

  test('the focused Windows profile checks every target without running the full suite', () => {
    expect(names('windows', 'win32')).toContain('Check all Windows native targets');
    expect(names('windows', 'win32')).not.toContain('Run locked Rust tests for all targets');
  });

  test('frontend checks typecheck once and build without a second tsc pass', () => {
    const steps = stepsForProfile('frontend');
    expect(steps.filter((entry) => entry.name === 'Typecheck frontend')).toHaveLength(1);
    expect(steps.find((entry) => entry.name === 'Build frontend')?.args).toEqual(['run', 'build:vite']);
  });

  test('classification selects the smallest safe profile', () => {
    expect(profileForClassification({ documentation_only: true })).toBe('documentation');
    expect(profileForClassification({ frontend: true })).toBe('frontend');
    expect(profileForClassification({ native: true })).toBe('full');
    expect(profileForClassification({ configuration: true })).toBe('full');
    expect(profileForClassification({})).toBe('full');
  });
});
