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
      'Run locked argentic-core tests for all targets',
      'Run locked argentic-core doc tests',
      'Run locked argentic-runtime tests for all targets',
      'Run locked argentic-runtime doc tests',
      'Build standalone Argentic host',
      'Verify native approval boundary',
      'Run locked Rust tests for all targets',
      'Run locked Rust doc tests',
      'Verify headless HTTP transport',
      'Verify native process interruption recovery',
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

test('process recovery is explicit in Linux native profiles and absent from frontend checks', () => {
  for (const profile of ['native', 'native-core', 'full']) {
    expect(stepsForProfile(profile, { platform: 'linux' }).filter(entry => entry.args.includes('test:native:process-recovery'))).toHaveLength(1);
  }
  for (const platform of ['darwin', 'win32']) {
    for (const profile of ['native', 'native-core', 'full']) {
      expect(stepsForProfile(profile, { platform }).some(entry => entry.args.includes('test:native:process-recovery'))).toBe(false);
    }
  }
  for (const profile of ['frontend', 'documentation', 'windows', 'windows-core', 'sidecar']) {
    expect(stepsForProfile(profile).some(entry => entry.args.includes('test:native:process-recovery'))).toBe(false);
  }
});


test('native profiles reuse the headless HTTP smoke once after native compilation', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const profile of ['native', 'native-core', 'windows', 'windows-core', 'full']) {
      const steps = stepsForProfile(profile, { platform });
      const checks = steps.filter(entry => entry.args.includes('test:e2e:headless'));
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ command: 'bun', args: ['run', 'test:e2e:headless'] });
      expect(steps.indexOf(checks[0])).toBeGreaterThan(steps.findLastIndex(entry => entry.command === 'cargo'));
    }
  }
  for (const profile of ['frontend', 'documentation', 'sidecar']) {
    expect(stepsForProfile(profile).some(entry => entry.args.includes('test:e2e:headless'))).toBe(false);
  }
});


test('exhaustive native profiles test both standalone workspaces and build the real host', () => {
  for (const profile of ['argentic', 'native', 'native-core', 'full']) {
    const steps = stepsForProfile(profile);
    for (const crate of ['argentic-core', 'argentic-runtime']) {
      const own = steps.filter(entry => entry.args.includes(`crates/${crate}/Cargo.toml`));
      expect(own.filter(entry => entry.args.includes('--all-targets') && entry.command === 'cargo')).toHaveLength(1);
      expect(own.filter(entry => entry.args.includes('--doc'))).toHaveLength(1);
      expect(own.every(entry => entry.args.includes('--locked'))).toBe(true);
    }
    expect(steps.filter(entry => entry.args.includes('argentic-host'))).toHaveLength(1);
    expect(steps.filter(entry => entry.args.includes('approval_boundary'))).toHaveLength(1);
  }
  expect(stepsForProfile('argentic').every(entry => entry.command === 'cargo')).toBe(true);
  for (const profile of ['windows', 'windows-core']) {
    for (const crate of ['argentic-core', 'argentic-runtime']) {
      expect(stepsForProfile(profile).filter(entry => entry.command === 'cargo'
        && entry.args[0] === 'check' && entry.args.includes(`crates/${crate}/Cargo.toml`)
        && entry.args.includes('--all-targets'))).toHaveLength(1);
    }
  }
});
