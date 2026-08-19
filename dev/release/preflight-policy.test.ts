import { describe, expect, test } from 'bun:test';
import { expectedReleaseTag, packageCommandForPlatform } from './preflight-policy.mjs';

describe('release preflight policy', () => {
  test('accepts stable versions and derives their tag', () => {
    expect(expectedReleaseTag('0.1.0')).toBe('v0.1.0');
    expect(expectedReleaseTag('2.10.3')).toBe('v2.10.3');
  });

  test('rejects prerelease versions', () => {
    expect(() => expectedReleaseTag('0.1.0-rc.1')).toThrow('stable x.y.z');
  });

  test('selects a native package command', () => {
    expect(packageCommandForPlatform('win32')).toEqual(['bun', ['run', 'tauri:build:nsis']]);
    expect(packageCommandForPlatform('darwin')[1]).toContain('tauri:build:dmg:mac-universal:test');
    expect(packageCommandForPlatform('linux')[1]).toContain('appimage,deb,rpm');
  });
});
