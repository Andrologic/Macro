#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const UPDATER_ENDPOINT = 'https://github.com/Andrologic/Macro/releases/latest/download/latest.json';
export const LOCAL_TAURI_CONFIG_PATH = 'src-tauri/tauri.local.conf.json';
export const TAURI_CAPABILITIES_PATH = 'src-tauri/capabilities/default.json';
const REQUIRED_UPDATER_PERMISSIONS = Object.freeze([
  'core:app:allow-version',
  'core:resources:allow-close',
  'updater:allow-check',
  'updater:allow-download',
  'updater:allow-install',
  'process:allow-restart',
]);
const VERSION_PARTS = /^[=^~\s]*(\d+)\.(\d+)/;
const VERSION_MAJOR = /^[=^~\s]*(\d+)/;
const TAURI_PLUGIN_PAIRS = Object.freeze([
  ['@tauri-apps/plugin-dialog', 'tauri-plugin-dialog'],
  ['@tauri-apps/plugin-http', 'tauri-plugin-http'],
  ['@tauri-apps/plugin-notification', 'tauri-plugin-notification'],
  ['@tauri-apps/plugin-opener', 'tauri-plugin-opener'],
  ['@tauri-apps/plugin-process', 'tauri-plugin-process'],
  ['@tauri-apps/plugin-store', 'tauri-plugin-store'],
  ['@tauri-apps/plugin-updater', 'tauri-plugin-updater'],
]);

function dependencyVersion(value, label) {
  const match = String(value ?? '').match(VERSION_PARTS);
  if (!match) {
    throw new Error(`${label} must contain a numeric major.minor version; found "${value}".`);
  }
  return `${match[1]}.${match[2]}`;
}

function cargoDependencyVersion(cargoToml, dependencyName) {
  const escapedName = dependencyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cargoToml.match(new RegExp(`^${escapedName}\\s*=\\s*(?:"([^\"]+)"|\\{[^}]*?version\\s*=\\s*"([^\"]+)"[^}]*\\})`, 'm'));
  return match?.[1] || match?.[2] || null;
}

export function cargoLockPackageVersion(cargoLock, packageName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const packageBlock = cargoLock.match(new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${escapedName}"\\s*\\nversion = "([^"]+)"`, 'm'));
  return packageBlock?.[1] || null;
}

function checkPluginVersion(errors, packageJson, cargoToml, cargoLock, npmName, cargoName) {
  const npmVersion = packageJson.dependencies?.[npmName];
  const cargoVersion = cargoDependencyVersion(cargoToml, cargoName);
  const lockVersion = cargoLockPackageVersion(cargoLock, cargoName);
  if (!npmVersion || !cargoVersion || !lockVersion) {
    errors.push(`Missing Tauri plugin dependency metadata for ${npmName} / ${cargoName}.`);
    return;
  }
  try {
    const npmLine = dependencyVersion(npmVersion, npmName);
    const lockLine = dependencyVersion(lockVersion, `Cargo.lock ${cargoName}`);
    if (npmLine !== lockLine) {
      errors.push(`${npmName} and the resolved ${cargoName} crate must use the same major/minor version (npm ${npmVersion}, lock ${lockVersion}).`);
    }

    const declaredMajor = String(cargoVersion).match(VERSION_MAJOR)?.[1];
    const lockMajor = String(lockVersion).match(VERSION_MAJOR)?.[1];
    if (!declaredMajor || declaredMajor !== lockMajor) {
      errors.push(`${cargoName} declaration ${cargoVersion} does not allow the resolved major version ${lockVersion}.`);
    }

    if (String(cargoVersion).trim().startsWith('=')) {
      const cargoLine = dependencyVersion(cargoVersion, cargoName);
      if (cargoLine !== lockLine) {
        errors.push(`${cargoName} exact requirement ${cargoVersion} does not match Cargo.lock ${lockVersion}.`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}

function isValidUpdaterPublicKey(value) {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
    const lines = decoded.split(/\r?\n/);
    return lines.length === 2
      && /^untrusted comment: minisign public key: [A-F0-9]{16}$/i.test(lines[0])
      && /^RW[A-Za-z0-9+/]{54}$/.test(lines[1]);
  } catch {
    return false;
  }
}

export function validateUpdaterConfiguration({
  packageJson,
  cargoToml,
  cargoLock,
  tauriConfig,
  localTauriConfig,
  tauriCapabilities,
}) {
  const errors = [];
  const updater = tauriConfig?.plugins?.updater;

  if (tauriConfig?.bundle?.createUpdaterArtifacts !== true) {
    errors.push('tauri.conf.json must set bundle.createUpdaterArtifacts to true.');
  }
  if (localTauriConfig?.bundle?.createUpdaterArtifacts !== false) {
    errors.push(`${LOCAL_TAURI_CONFIG_PATH} must disable updater artifacts for ordinary local builds.`);
  }

  const permissions = Array.isArray(tauriCapabilities?.permissions)
    ? tauriCapabilities.permissions
    : [];
  for (const permission of REQUIRED_UPDATER_PERMISSIONS) {
    if (!permissions.includes(permission)) {
      errors.push(`${TAURI_CAPABILITIES_PATH} must grant ${permission}.`);
    }
  }

  const scripts = packageJson?.scripts ?? {};
  const localBuildScripts = [
    'tauri:build',
    'tauri:build:nsis',
    'tauri:build:dmg',
    'tauri:build:dmg:mac-arm64:test',
    'tauri:build:dmg:mac-universal:test',
    'tauri:build:linux-packages',
    'tauri:build:debug',
  ];
  for (const scriptName of localBuildScripts) {
    if (!String(scripts[scriptName] ?? '').includes(`--config ${LOCAL_TAURI_CONFIG_PATH}`)) {
      errors.push(`package.json script ${scriptName} must use ${LOCAL_TAURI_CONFIG_PATH}.`);
    }
  }
  if (!scripts['tauri:build:updater']) {
    errors.push('package.json must define tauri:build:updater for an explicitly signed updater build.');
  } else if (String(scripts['tauri:build:updater']).includes(LOCAL_TAURI_CONFIG_PATH)) {
    errors.push('package.json script tauri:build:updater must keep updater artifacts enabled.');
  }
  if (!updater || typeof updater !== 'object') {
    errors.push('tauri.conf.json must configure plugins.updater.');
  } else {
    if (typeof updater.pubkey !== 'string' || updater.pubkey.trim() === '') {
      errors.push('plugins.updater.pubkey must contain the Tauri updater public key.');
    } else if (/replace_with|placeholder|your[_ -]?public[_ -]?key|<public[_ -]?key>/i.test(updater.pubkey)) {
      errors.push('plugins.updater.pubkey still contains a placeholder.');
    } else if (!isValidUpdaterPublicKey(updater.pubkey)) {
      errors.push('plugins.updater.pubkey must be a base64-encoded minisign public key.');
    }

    if (!Array.isArray(updater.endpoints) || !updater.endpoints.includes(UPDATER_ENDPOINT)) {
      errors.push(`plugins.updater.endpoints must include ${UPDATER_ENDPOINT}.`);
    }

    if (updater.windows?.installMode !== 'passive') {
      errors.push('plugins.updater.windows.installMode must be "passive".');
    }
  }

  for (const [npmName, cargoName] of TAURI_PLUGIN_PAIRS) {
    checkPluginVersion(errors, packageJson, cargoToml, cargoLock, npmName, cargoName);
  }
  return errors;
}

export function readProjectUpdaterConfiguration(root = process.cwd()) {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
  return {
    packageJson: readJson(`${root}/package.json`),
    cargoToml: readFileSync(`${root}/src-tauri/Cargo.toml`, 'utf8'),
    cargoLock: readFileSync(`${root}/src-tauri/Cargo.lock`, 'utf8'),
    tauriConfig: readJson(`${root}/src-tauri/tauri.conf.json`),
    localTauriConfig: readJson(`${root}/${LOCAL_TAURI_CONFIG_PATH}`),
    tauriCapabilities: readJson(`${root}/${TAURI_CAPABILITIES_PATH}`),
  };
}

function main() {
  const errors = validateUpdaterConfiguration(readProjectUpdaterConfiguration());
  if (errors.length > 0) {
    console.error('Tauri updater preflight failed:');
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log('Tauri updater preflight passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
