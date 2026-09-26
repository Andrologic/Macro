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

  test('native core builds the required sidecar before Rust tests on a clean checkout', () => {
    expect(names('native-core')).toEqual([
      'Install locked frontend dependencies',
      'Check version manifests',
      'Reject generated binaries',
      'Check Tauri updater configuration',
      'Check domain import boundaries',
      'Typecheck Copilot bridge',
      'Build AI runtime sidecar',
      'Check generated config contracts',
      'Check generated ipc contracts',
      'Run locked Rust tests for all targets',
      'Run locked Rust doc tests',
    ]);
  });

  test('sidecar checks install dependencies unless the caller already did', () => {
    expect(names('sidecar')).toEqual([
      'Install locked frontend dependencies',
      'Typecheck Copilot bridge',
      'Build AI runtime sidecar',
    ]);
    expect(stepsForProfile('sidecar', { skipInstall: true }).map((entry) => entry.name)).toEqual([
      'Typecheck Copilot bridge',
      'Build AI runtime sidecar',
    ]);
  });

  test('full profiles test every native target once on every platform', () => {
    for (const platform of ['linux', 'win32']) {
      const steps = stepsForProfile('full', { platform });
      const rustTests = steps.find((entry) => entry.name === 'Run locked Rust tests for all targets');
      expect(rustTests?.args).toContain('--all-targets');
      expect(steps.filter((entry) => entry.name === 'Run locked Rust doc tests')).toHaveLength(1);
      expect(steps.filter((entry) => entry.name === 'Check all Windows native targets')).toHaveLength(0);
    }
  });

  test('the focused Windows profile checks every target without running the full suite', () => {
    expect(names('windows', 'win32')).toContain('Check all Windows native targets');
    expect(names('windows', 'win32')).not.toContain('Run locked Rust tests for all targets');
  });

  test('Windows core prepares the required sidecar before checking Rust targets', () => {
    const checks = names('windows-core', 'win32');
    expect(checks).toContain('Check all Windows native targets');
    expect(checks.indexOf('Install locked frontend dependencies')).toBe(0);
    expect(checks.indexOf('Build AI runtime sidecar')).toBeGreaterThan(0);
    expect(checks.indexOf('Build AI runtime sidecar')).toBeLessThan(checks.indexOf('Check all Windows native targets'));
    expect(checks).not.toContain('Run frontend tests');
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

  test('checks extracted boundaries once before native compilation in every native profile', () => {
    for (const profile of ['native', 'native-core', 'windows', 'windows-core', 'full']) {
      const steps = stepsForProfile(profile, { skipInstall: true });
      const guards = steps.filter((entry) => entry.args.includes('architecture:check'));
      expect(guards).toHaveLength(1);
      expect(steps.indexOf(guards[0])).toBeLessThan(steps.findIndex((entry) => entry.command === 'cargo'));
    }
  });

  test('typechecks Copilot once in code profiles and before building a sidecar', () => {
    for (const profile of ['frontend', 'native', 'native-core', 'sidecar', 'windows', 'windows-core', 'full']) {
      for (const skipInstall of [false, true]) {
        const steps = stepsForProfile(profile, { skipInstall });
        const checks = steps.filter((entry) => entry.args.includes('typecheck:copilot'));
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({ command: 'bun', args: ['run', 'typecheck:copilot'] });
        const sidecarIndex = steps.findIndex((entry) => entry.args.includes('build:ai-runtime'));
        if (sidecarIndex !== -1) expect(steps.indexOf(checks[0])).toBeLessThan(sidecarIndex);
      }
    }
    expect(stepsForProfile('documentation').some((entry) => entry.args.includes('typecheck:copilot'))).toBe(false);
  });
});


test('active native profiles check both generated contract domains after the sidecar', () => {
  for (const profile of ['native', 'native-core', 'windows', 'windows-core', 'full']) {
    const steps = stepsForProfile(profile);
    for (const domain of ['config', 'ipc']) {
      const checks = steps.filter((entry) => entry.args.includes('generate_config') && entry.args.includes(domain));
      expect(checks).toHaveLength(1);
      expect(checks[0].args).toContain('--check');
      expect(checks[0].args).toContain('--locked');
      expect(steps.indexOf(checks[0])).toBeGreaterThan(steps.findIndex((entry) => entry.name === 'Build AI runtime sidecar'));
    }
  }
  expect(stepsForProfile('frontend').some((entry) => entry.args.includes('generate_config'))).toBe(false);
});
