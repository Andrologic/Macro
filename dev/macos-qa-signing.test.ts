import { createHash } from 'node:crypto';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertOutsideRepository,
  IDENTITY_ENV,
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
    const requirement = `identifier "${QA_BUNDLE_IDENTIFIER}" and anchor apple generic`;
    const inspected = [];
    const fakeCodesign = (command, args) => {
      inspected.push([command, ...args]);
      if (args[0] === '--verify' || args[0] === '-dr') {
        return args[0] === '--verify' ? '' : `Executable=Macro\ndesignated => ${requirement}\n`;
      }
      writeFileSync(`${args[2]}0`, certificate);
      return '';
    };

    expect(verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, fakeCodesign)).toBe(requirement);
    expect(inspected.map(([, ...args]) => args[0])).toEqual([
      '--verify', '-dr', '--display', '--verify', '-dr', '--display',
    ]);
    expect(() => verifySameDesignatedRequirement(firstBundle, bundleAlias, fingerprint, fakeCodesign))
      .toThrow('same macOS app');
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, 'F'.repeat(40), fakeCodesign))
      .toThrow('was signed by');

    const mismatchedCertificate = (command, args) => {
      if (args[0] === '--verify') return '';
      if (args[0] === '-dr') return `designated => ${requirement}`;
      writeFileSync(`${args[2]}0`, Buffer.from('different synthetic certificate'));
      return '';
    };
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, mismatchedCertificate))
      .toThrow('was signed by');

    const mismatchedRequirement = (command, args) => {
      if (args[0] === '--verify') return '';
      if (args[0] === '-dr') return `designated => ${requirement} and certificate leaf[subject.CN] = "${args.at(-1)}"`;
      writeFileSync(`${args[2]}0`, certificate);
      return '';
    };
    expect(() => verifySameDesignatedRequirement(firstBundle, secondBundle, fingerprint, mismatchedRequirement))
      .toThrow('same designated');
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
  });
});
