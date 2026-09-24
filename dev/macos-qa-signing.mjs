#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const QA_BUNDLE_IDENTIFIER = 'com.macro.desktop.qa.pilot';
export const QA_CONFIG = 'src-tauri/tauri.qa.conf.json';
export const IDENTITY_ENV = 'MACOS_QA_SIGNING_IDENTITY';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fingerprintPattern = /^[0-9A-F]{40}$/i;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: options.env || process.env,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${output.trim() ? `:\n${output.trim()}` : ''}`);
  }
  return output;
};

export function resolveSigningIdentity(identity, runCommand) {
  if (typeof identity !== 'string' || !fingerprintPattern.test(identity)) {
    throw new Error(`${IDENTITY_ENV} must contain the 40-character SHA-1 fingerprint of a valid code-signing identity.`);
  }

  const output = runCommand('security', ['find-identity', '-v', '-p', 'codesigning']);
  const validFingerprints = new Set(
    output.split(/\r?\n/)
      .map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"/i)?.[1]?.toUpperCase())
      .filter(Boolean),
  );
  const normalized = identity.toUpperCase();
  if (!validFingerprints.has(normalized)) {
    throw new Error(`Signing identity ${normalized} is not present in the valid code-signing identity list. No ad hoc fallback is allowed.`);
  }
  return normalized;
}

export function verifySameDesignatedRequirement(firstPath, secondPath, runCommand) {
  if (!firstPath || !secondPath || resolve(firstPath) === resolve(secondPath)) {
    throw new Error('Provide two different macOS app bundle paths.');
  }
  if (realpathSync(firstPath) === realpathSync(secondPath)) {
    throw new Error('The two paths resolve to the same macOS app bundle.');
  }

  const requirements = [firstPath, secondPath].map((appPath) => {
    runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    const output = runCommand('codesign', ['-dr', '-', appPath]);
    const designated = output.match(/^designated => (.+)$/m)?.[1]?.trim();
    if (!designated) {
      throw new Error(`No designated code requirement found for ${appPath}.`);
    }
    const identifier = designated.match(/\bidentifier "([^"]+)"/i)?.[1];
    if (identifier !== QA_BUNDLE_IDENTIFIER) {
      throw new Error(`${appPath} has bundle identifier ${identifier || 'unknown'}, expected ${QA_BUNDLE_IDENTIFIER}.`);
    }
    if (!/\b(?:anchor|certificate)\b/i.test(designated)) {
      throw new Error(`${appPath} does not have a designated requirement tied to a stable signing identity.`);
    }
    return designated;
  });

  if (requirements[0] !== requirements[1]) {
    throw new Error('The two QA bundles do not satisfy the same designated code requirement.');
  }
  return requirements[0];
}

function assertOutsideRepository(path) {
  const fromRoot = relative(root, path);
  if (fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))) {
    throw new Error('Choose a QA bundle output directory outside the repository.');
  }
}

function build(outputDirectory, identity, runCommand = run, spawn = spawnSync) {
  if (process.platform !== 'darwin') {
    throw new Error('The stable signing QA build runs on macOS only.');
  }
  if (!outputDirectory || !isAbsolute(outputDirectory)) {
    throw new Error('Pass an absolute --output directory for this build.');
  }
  const destination = resolve(outputDirectory);
  assertOutsideRepository(destination);
  if (existsSync(destination)) {
    throw new Error(`Output directory already exists; choose a new path: ${destination}`);
  }

  const signingIdentity = resolveSigningIdentity(identity, runCommand);
  const target = 'aarch64-apple-darwin';
  const result = spawn('bun', [
    'dev/tauri-cli.mjs', 'build',
    '--config', QA_CONFIG,
    '--target', target,
    '--bundles', 'app',
  ], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', APPLE_SIGNING_IDENTITY: signingIdentity },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri QA build failed with status ${result.status ?? 'unknown'}.`);

  const appPath = resolve(root, 'src-tauri', 'target', target, 'release', 'bundle', 'macos', 'Macro Pilot QA.app');
  if (!existsSync(appPath)) throw new Error(`Tauri did not produce the expected bundle: ${appPath}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(appPath, destination, { recursive: true, errorOnExist: true, force: false });
  console.log(`QA bundle saved at ${destination}`);
}

function parseArgs(args) {
  const options = { action: args[0], output: null, bundles: [] };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output') options.output = args[++index];
    else if (arg === '--bundles') options.bundles.push(args[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function main(args = process.argv.slice(2), env = process.env) {
  const options = parseArgs(args);
  if (options.action === 'build') {
    build(options.output, env[IDENTITY_ENV]);
    return;
  }
  if (options.action === 'verify' && options.bundles.length === 2 && !options.output) {
    const requirement = verifySameDesignatedRequirement(
      options.bundles[0], options.bundles[1],
      (command, commandArgs) => run(command, commandArgs),
    );
    console.log(`Both bundles satisfy the same designated requirement: ${requirement}`);
    console.log('This checks code requirements only; it does not demonstrate keychain access or session restoration.');
    return;
  }
  throw new Error('Usage: macos-qa-signing.mjs build --output /absolute/path/Macro.app | verify --bundles /path/one.app --bundles /path/two.app');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
