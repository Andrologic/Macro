import { createHash } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertOutsideRepository,
  IDENTITY_ENV,
  QA_ARCHITECTURE,
  QA_BUNDLE_IDENTIFIER,
  resolveSigningIdentity,
  verifySameDesignatedRequirement,
} from './macos-qa-signing.mjs';

const certificate = Buffer.from('synthetic public signing certificate');
const fingerprint = createHash('sha1').update(certificate).digest('hex').toUpperCase();
const identityList = `  1) ${fingerprint} "Apple Development: Example (ABCDE12345)"\n     1 valid identities found`;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'macro-qa-signing-'));
const firstBundle = join(fixtureRoot, 'first.app');
const secondBundle = join(fixtureRoot, 'second.app');
const bundleAlias = join(fixtureRoot, 'bundle-alias.app');
const repository = join(fixtureRoot, 'repo');
const repositoryAlias = join(fixtureRoot, 'repo-alias');
mkdirSync(firstBundle);
mkdirSync(secondBundle);
mkdirSync(repository);
symlinkSync(firstBundle, bundleAlias);
symlinkSync(repository, repositoryAlias);
const designatedRequirement = `identifier "${QA_BUNDLE_IDENTIFIER}" and anchor apple generic`;

function fakeTools({
  inspected = [],
  cdHashes = new Map([[firstBundle, 'A'.repeat(40)], [secondBundle, 'B'.repeat(40)]]),
  certificates = new Map(),
  requirements = new Map(),
  bundleIdentifiers = new Map([[firstBundle, QA_BUNDLE_IDENTIFIER], [secondBundle, QA_BUNDLE_IDENTIFIER]]),
  omitCdHash = false,
} = {}) {
  return (command, args) => {
    const appPath = command === 'plutil' ? dirname(dirname(args.at(-1))) : args.at(-1);
    inspected.push([command, ...args]);
    if (command === 'plutil') return bundleIdentifiers.get(appPath) || QA_BUNDLE_IDENTIFIER;
    if (args[0] === '--verify') return '';
    if (args[0] === '-dr') {
      return `Executable=Macro\ndesignated => ${requirements.get(appPath) || designatedRequirement}\n`;
    }
    if (args[0] === '--display' && args[1] === '--extract-certificates') {
      writeFileSync(`${args[2]}0`, certificates.get(appPath) || certificate);
      return '';
    }
    if (args[0] === '--display' && args[1] === '--verbose=4') {
      expect(args.slice(2, 4)).toEqual(['--arch', QA_ARCHITECTURE]);
      return omitCdHash ? 'Executable=Macro' : `Executable=Macro\nCDHash=${cdHashes.get(appPath)}\n`;
    }
    throw new Error(`Unexpected fake codesign args: ${args.join(' ')}`);
  };
}

describe('macOS Pilot QA signing', () => {
  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  test('requires an explicit valid SHA-1 identity and rejects ad hoc signing', () => {
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

  test('checks two physical bundles against the same requirement and leaf certificate', () => {
    const inspected = [];
    const cdHashes = new Map([[firstBundle, 'A'.repeat(40)], [secondBundle, 'B'.repeat(40)]]);
    const fake = fakeTools({ inspected, cdHashes });

    expect(verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fake)).toEqual([
      { designated: designatedRequirement, codeDirectoryHash: 'A'.repeat(40) },
      { designated: designatedRequirement, codeDirectoryHash: 'B'.repeat(40) },
    ]);
    expect(inspected.map(([command, ...args]) => command === 'plutil' ? 'plutil' : args[0])).toEqual([
      '--verify', 'plutil', '-dr', '--display', '--display', '--verify', 'plutil', '-dr', '--display', '--display',
    ]);
    expect(() => verifySameDesignatedRequirement(firstBundle, bundleAlias, fingerprint, fake))
      .toThrow('same macOS app');
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, 'F'.repeat(40), fake))
      .toThrow('was signed by');
    const bundleIdentifiers = new Map([[secondBundle, 'com.macro.desktop']]);
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fakeTools({ bundleIdentifiers })))
      .toThrow('bundle identifier com.macro.desktop');

    const certificates = new Map([[secondBundle, Buffer.from('different synthetic certificate')]]);
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fakeTools({ certificates })))
      .toThrow('was signed by');

    const requirements = new Map([[secondBundle, `${designatedRequirement} and certificate leaf[subject.CN] = "other"`]]);
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fakeTools({ requirements })))
      .toThrow('same designated');

    cdHashes.set(secondBundle, 'A'.repeat(40));
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fakeTools({ cdHashes })))
      .toThrow('same arm64 CDHash');

    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fakeTools({ omitCdHash: true })))
      .toThrow('No arm64 CDHash');
  });

  test('rejects QA bundle outputs that reach the repository through a symlink', () => {
    expect(() => assertOutsideRepository(join(repositoryAlias, 'bundles', 'Macro.app'), repository))
      .toThrow('outside the repository');
    expect(assertOutsideRepository(join(fixtureRoot, 'outside', 'Macro.app'), repository))
      .toEndWith('/outside/Macro.app');
  });

  test('QA Tauri configuration isolates the app and removes publication endpoints', () => {
    const config = JSON.parse(readFileSync('src-tauri/tauri.qa.conf.json', 'utf8'));
    expect(config.identifier).toBe(QA_BUNDLE_IDENTIFIER);
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.bundle.targets).toEqual(['app']);
    expect(config.plugins.updater.endpoints).toEqual([]);
    expect(config.productName).toBe('Macro Pilot QA');
    expect(config.app.windows[0].title).toBe('Macro Pilot QA');
  });
});
