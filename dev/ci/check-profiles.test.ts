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
    expect(checks).toContain('Run locked Rust tests');
    expect(checks).toContain('Check headless example');
    expect(checks).not.toContain('Check all Windows native targets');
  });

  test('full Windows checks include all native targets', () => {
    expect(names('full', 'win32')).toContain('Check all Windows native targets');
    expect(names('full', 'linux')).not.toContain('Check all Windows native targets');
  });

  test('classification selects the smallest safe profile', () => {
    expect(profileForClassification({ documentation_only: true })).toBe('documentation');
    expect(profileForClassification({ frontend: true })).toBe('frontend');
    expect(profileForClassification({ native: true })).toBe('full');
    expect(profileForClassification({ configuration: true })).toBe('full');
    expect(profileForClassification({})).toBe('full');
  });
});
