import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  IDENTITY_ENV,
  QA_BUNDLE_IDENTIFIER,
  resolveSigningIdentity,
  verifySameDesignatedRequirement,
} from './macos-qa-signing.mjs';

const fingerprint = '0123456789ABCDEF0123456789ABCDEF01234567';
const identityList = `  1) ${fingerprint} "Apple Development: Example (ABCDE12345)"\n     1 valid identities found`;

describe('macOS Pilot QA signing', () => {
  test('requires an explicit valid SHA-1 identity and never accepts ad hoc signing', () => {
    const calls = [];
    const fakeSecurity = (command, args) => {
      calls.push([command, args]);
      return identityList;
    };

    expect(resolveSigningIdentity(fingerprint.toLowerCase(), fakeSecurity)).toBe(fingerprint);
    expect(() => resolveSigningIdentity(undefined, fakeSecurity)).toThrow(IDENTITY_ENV);
    expect(() => resolveSigningIdentity('-', fakeSecurity)).toThrow(IDENTITY_ENV);
    expect(() => resolveSigningIdentity('F'.repeat(40), () => identityList)).toThrow('not present');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['security', ['find-identity', '-v', '-p', 'codesigning']]);
  });

  test('accepts two distinct bundles with the same expected designated requirement', () => {
    const requirement = `identifier "${QA_BUNDLE_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"`;
    const inspected = [];
    const fakeCodesign = (command, args) => {
      inspected.push([command, ...args]);
      if (args[0] === '--verify') return '';
      return `Executable=Macro\ndesignated => ${requirement}\n`;
    };

    expect(verifySameDesignatedRequirement('/qa/first.app', '/qa/second.app', fakeCodesign)).toBe(requirement);
    expect(inspected).toEqual([
      ['codesign', '--verify', '--deep', '--strict', '--verbose=2', '/qa/first.app'],
      ['codesign', '-dr', '-', '/qa/first.app'],
      ['codesign', '--verify', '--deep', '--strict', '--verbose=2', '/qa/second.app'],
      ['codesign', '-dr', '-', '/qa/second.app'],
    ]);
    expect(() => verifySameDesignatedRequirement('/qa/same.app', '/qa/same.app', fakeCodesign)).toThrow('two different');
    expect(() => verifySameDesignatedRequirement('/qa/first.app', '/qa/second.app', () => 'no requirement'))
      .toThrow('No designated');
    expect(() => verifySameDesignatedRequirement('/qa/first.app', '/qa/second.app', (_command, args) =>
      args[0] === '--verify' ? '' : `designated => identifier "com.macro.desktop" and anchor apple generic (${args.at(-1)})`))
      .toThrow('expected com.macro.desktop.qa.pilot');
    expect(() => verifySameDesignatedRequirement('/qa/first.app', '/qa/second.app', (_command, args) =>
      args[0] === '--verify' ? '' : `designated => identifier "${QA_BUNDLE_IDENTIFIER}" and requirement ${args.at(-1)}`))
      .toThrow('same designated');
  });

  test('QA Tauri configuration isolates the app and disables updater publication artifacts', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.qa.conf.json', 'utf8'));
    expect(config.identifier).toBe(QA_BUNDLE_IDENTIFIER);
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.bundle.targets).toEqual(['app']);
    expect(config.productName).toBe('Macro Pilot QA');
  });
});
