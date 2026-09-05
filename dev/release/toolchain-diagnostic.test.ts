import { describe, expect, test } from 'bun:test';
import {
  declaredRustChannel,
  evaluateToolchainDiagnostic,
  requiredRustTargets,
} from './toolchain-diagnostic.mjs';

describe('release toolchain diagnostic', () => {
  test('reads the pinned toolchain and platform targets', () => {
    expect(declaredRustChannel('[toolchain]\nchannel = "1.95.0"\n')).toBe('1.95.0');
    expect(requiredRustTargets('darwin', 'arm64')).toEqual([
      'aarch64-apple-darwin',
      'x86_64-apple-darwin',
    ]);
    expect(requiredRustTargets('win32', 'arm64')).toEqual(['aarch64-pc-windows-msvc']);
  });

  test('fails on a shadowed compiler, missing target, or prerequisite', () => {
    const result = evaluateToolchainDiagnostic({
      declaredChannel: '1.95.0',
      rustcVersion: 'rustc 1.94.0',
      cargoVersion: 'cargo 1.95.0',
      requiredTargets: ['aarch64-apple-darwin', 'x86_64-apple-darwin'],
      installedTargets: ['aarch64-apple-darwin'],
      probes: [{ command: 'xcrun --find lipo', ok: false, output: null }],
    });
    expect(result.ok).toBe(false);
    expect(result.missingTargets).toEqual(['x86_64-apple-darwin']);
    expect(result.failedProbes).toEqual(['xcrun --find lipo']);
  });
});
