import { describe, expect, it } from 'bun:test';
import {
  bumpVersion,
  getCargoLockPackageVersion,
  getCargoPackageVersion,
  updateCargoLockPackageVersion,
  updateCargoPackageVersion,
} from './shared.mjs';

describe('version shared helpers', () => {
  it('updates the Cargo package version without touching dependency versions', () => {
    const input = [
      '[package]',
      'name = "macro"',
      'version = "0.1.0"',
      '',
      '[dependencies]',
      'tauri = { version = "2", features = [] }',
      '',
    ].join('\n');

    const output = updateCargoPackageVersion(input, '0.2.0-beta.1');

    expect(getCargoPackageVersion(output)).toBe('0.2.0-beta.1');
    expect(output).toContain('tauri = { version = "2", features = [] }');
  });

  it('updates the root package version in Cargo.lock', () => {
    const input = [
      'version = 4',
      '',
      '[[package]]',
      'name = "macro"',
      'version = "0.1.0"',
      '',
      '[[package]]',
      'name = "serde"',
      'version = "1.0.0"',
      '',
    ].join('\n');

    const output = updateCargoLockPackageVersion(input, '0.2.0-weekly.20260325.0');

    expect(getCargoLockPackageVersion(output)).toBe('0.2.0-weekly.20260325.0');
    expect(output).toContain('name = "serde"\nversion = "1.0.0"');
  });

  it('removes the prerelease suffix on patch bumps', () => {
    expect(bumpVersion('0.2.0-beta.1', 'patch')).toBe('0.2.0');
  });

  it('creates labeled prereleases from stable versions', () => {
    expect(bumpVersion('0.2.0', 'prerelease', 'rc')).toBe('0.2.1-rc.0');
  });

  it('supports the rc alias for manual release candidates', () => {
    expect(bumpVersion('0.2.0', 'rc')).toBe('0.2.1-rc.0');
    expect(bumpVersion('0.2.1-rc.0', 'rc')).toBe('0.2.1-rc.1');
  });

  it('increments matching prerelease identifiers', () => {
    expect(bumpVersion('0.2.1-rc.0', 'prerelease', 'rc')).toBe('0.2.1-rc.1');
  });

  it('switches prerelease identifiers when requested', () => {
    expect(bumpVersion('0.2.1-alpha.3', 'prerelease', 'beta')).toBe('0.2.1-beta.0');
  });

  it('creates weekly prereleases from stable versions', () => {
    expect(bumpVersion('0.2.0', 'weekly', '20260325')).toBe('0.2.1-weekly.20260325.0');
  });

  it('keeps the same base patch while rotating weekly stamps', () => {
    expect(bumpVersion('0.2.1-weekly.20260318.0', 'weekly', '20260325')).toBe(
      '0.2.1-weekly.20260325.0'
    );
  });

  it('increments the weekly sequence on same-day reruns', () => {
    expect(bumpVersion('0.2.1-weekly.20260325.0', 'weekly', '20260325')).toBe(
      '0.2.1-weekly.20260325.1'
    );
  });
});
