import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const versionDir = dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = resolve(versionDir, '..', '..');
export const PACKAGE_JSON_PATH = resolve(ROOT_DIR, 'package.json');
export const CARGO_TOML_PATH = resolve(ROOT_DIR, 'src-tauri', 'Cargo.toml');
export const CARGO_LOCK_PATH = resolve(ROOT_DIR, 'src-tauri', 'Cargo.lock');
export const TAURI_CONF_PATH = resolve(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
export const FLAKE_NIX_PATH = resolve(ROOT_DIR, 'flake.nix');
export const SETTINGS_MODAL_PATH = resolve(
  ROOT_DIR,
  'src',
  'components',
  'settings',
  'SettingsModal.tsx'
);
export const TAURI_PACKAGE_VERSION_REFERENCE = '../package.json';
export const CARGO_PACKAGE_NAME = 'macro';
export const RC_PRERELEASE_IDENTIFIER = 'rc';
export const WEEKLY_PRERELEASE_IDENTIFIER = 'weekly';

const SEMVER_REGEX =
  /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const HARD_CODED_SEMVER_REGEX = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/;
const HARD_CODED_BUILD_REGEX = /\bBuild\s+\d+\b/;
const FLAKE_PACKAGE_JSON_REGEX =
  /packageJson\s*=\s*builtins\.fromJSON\s*\(builtins\.readFile\s+\.\/*package\.json\);/;
const FLAKE_VERSION_ASSIGNMENT_REGEX = /version\s*=\s*packageJson\.version;/;
const FLAKE_HARDCODED_VERSION_REGEX = /version\s*=\s*"[^"]+";/;

export const readTextFile = (path) => readFileSync(path, 'utf8');
export const writeTextFile = (path, content) => writeFileSync(path, content);

export const assertValidSemver = (value) => {
  if (typeof value !== 'string' || !SEMVER_REGEX.test(value.trim())) {
    throw new Error(`Invalid semver version "${value}"`);
  }

  return value.trim();
};

export const parseSemver = (value) => {
  const version = assertValidSemver(value);
  const match = version.match(SEMVER_REGEX);

  if (!match?.groups) {
    throw new Error(`Invalid semver version "${value}"`);
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease ? match.groups.prerelease.split('.') : [],
    build: match.groups.build ? match.groups.build.split('.') : [],
  };
};

export const formatSemver = ({ major, minor, patch, prerelease = [] }) => {
  const prereleaseSuffix = prerelease.length > 0 ? `-${prerelease.join('.')}` : '';
  return `${major}.${minor}.${patch}${prereleaseSuffix}`;
};

export const getCurrentWeeklyStamp = (date = new Date()) => {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

export const normalizeWeeklyStamp = (value) => {
  if (value === undefined || value === null || value === '') {
    return getCurrentWeeklyStamp();
  }

  if (typeof value !== 'string' || !/^\d{8}$/.test(value.trim())) {
    throw new Error(`Invalid weekly release stamp "${value}". Expected YYYYMMDD.`);
  }

  return value.trim();
};

const normalizePreid = (preid) => {
  if (preid === undefined || preid === null || preid === '') {
    return null;
  }

  if (!/^[0-9A-Za-z-]+$/.test(preid)) {
    throw new Error(`Invalid prerelease identifier "${preid}"`);
  }

  return preid;
};

const createPrerelease = (version, preid) => ({
  ...version,
  prerelease: preid ? [preid, '0'] : ['0'],
});

const getNextPrereleaseBase = (version) =>
  version.prerelease.length > 0
    ? { major: version.major, minor: version.minor, patch: version.patch, prerelease: [] }
    : { major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: [] };

const bumpExistingPrerelease = (version, preid) => {
  const current = [...version.prerelease];

  if (preid) {
    if (current[0] !== preid) {
      return {
        ...version,
        prerelease: [preid, '0'],
      };
    }

    const last = current[current.length - 1];
    if (/^\d+$/.test(last)) {
      current[current.length - 1] = String(Number(last) + 1);
      return {
        ...version,
        prerelease: current,
      };
    }

    return {
      ...version,
      prerelease: [...current, '0'],
    };
  }

  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (/^\d+$/.test(current[index])) {
      current[index] = String(Number(current[index]) + 1);
      return {
        ...version,
        prerelease: current,
      };
    }
  }

  return {
    ...version,
    prerelease: [...current, '0'],
  };
};

export const bumpWeeklyVersion = (currentVersion, weeklyStamp) => {
  const version = parseSemver(currentVersion);
  const normalizedWeeklyStamp = normalizeWeeklyStamp(weeklyStamp);
  const baseVersion = getNextPrereleaseBase(version);
  let sequence = '0';

  if (
    version.prerelease[0] === WEEKLY_PRERELEASE_IDENTIFIER &&
    version.prerelease[1] === normalizedWeeklyStamp
  ) {
    const currentSequence = version.prerelease[2];
    if (/^\d+$/.test(currentSequence ?? '')) {
      sequence = String(Number(currentSequence) + 1);
    } else {
      sequence = '1';
    }
  }

  return formatSemver({
    ...baseVersion,
    prerelease: [WEEKLY_PRERELEASE_IDENTIFIER, normalizedWeeklyStamp, sequence],
  });
};

export const bumpVersion = (currentVersion, releaseType, preid) => {
  const version = parseSemver(currentVersion);
  const normalizedPreid = releaseType === 'weekly' ? null : normalizePreid(preid);

  switch (releaseType) {
    case 'major':
      return formatSemver({ major: version.major + 1, minor: 0, patch: 0 });
    case 'minor':
      return formatSemver({ major: version.major, minor: version.minor + 1, patch: 0 });
    case 'patch':
      return version.prerelease.length > 0
        ? formatSemver({ major: version.major, minor: version.minor, patch: version.patch })
        : formatSemver({ major: version.major, minor: version.minor, patch: version.patch + 1 });
    case 'premajor':
      return formatSemver(
        createPrerelease({ major: version.major + 1, minor: 0, patch: 0, prerelease: [] }, normalizedPreid)
      );
    case 'preminor':
      return formatSemver(
        createPrerelease({ major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] }, normalizedPreid)
      );
    case 'prepatch':
      return formatSemver(
        createPrerelease({ major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: [] }, normalizedPreid)
      );
    case 'rc':
      if (version.prerelease.length > 0) {
        return formatSemver(bumpExistingPrerelease(version, RC_PRERELEASE_IDENTIFIER));
      }

      return formatSemver(
        createPrerelease(
          { major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: [] },
          RC_PRERELEASE_IDENTIFIER
        )
      );
    case 'prerelease':
      if (version.prerelease.length > 0) {
        return formatSemver(bumpExistingPrerelease(version, normalizedPreid));
      }

      return formatSemver(
        createPrerelease({ major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: [] }, normalizedPreid)
      );
    case 'weekly':
      return bumpWeeklyVersion(currentVersion, preid);
    default:
      throw new Error(
        `Unsupported release type "${releaseType}". Use major, minor, patch, premajor, preminor, prepatch, prerelease, rc, weekly, or an explicit semver version.`
      );
  }
};

export const readPackageJson = () => JSON.parse(readTextFile(PACKAGE_JSON_PATH));

export const getCargoLockDependencyVersions = (content) => {
  const versions = new Map();
  for (const block of content.split(/\r?\n(?=\[\[package\]\])/)) {
    if (!block.startsWith('[[package]]')) {
      continue;
    }
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) {
      versions.set(name, version);
    }
  }
  return versions;
};

const majorMinor = (version) => {
  const parsed = parseSemver(version);
  return `${parsed.major}.${parsed.minor}`;
};

export const getTauriDependencyIssues = (packageJson, cargoLockContent) => {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };
  const issues = [];
  const apiVersion = dependencies['@tauri-apps/api'];
  const cliVersion = dependencies['@tauri-apps/cli'];
  const cargoVersions = getCargoLockDependencyVersions(cargoLockContent);
  const rustTauriVersion = cargoVersions.get('tauri');

  if (!apiVersion || !cliVersion) {
    issues.push('@tauri-apps/api and @tauri-apps/cli must both use exact versions.');
  } else if (apiVersion !== cliVersion) {
    issues.push(
      `@tauri-apps/api (${apiVersion}) and @tauri-apps/cli (${cliVersion}) must use the same version.`
    );
  }

  if (apiVersion && rustTauriVersion && majorMinor(apiVersion) !== majorMinor(rustTauriVersion)) {
    issues.push(
      `@tauri-apps/api (${apiVersion}) and Rust tauri (${rustTauriVersion}) must use the same major and minor version.`
    );
  }

  for (const [packageName, jsVersion] of Object.entries(dependencies)) {
    if (!packageName.startsWith('@tauri-apps/plugin-')) {
      continue;
    }
    const crateName = `tauri-${packageName.slice('@tauri-apps/'.length).replaceAll('_', '-')}`;
    const rustVersion = cargoVersions.get(crateName);
    if (!rustVersion) {
      issues.push(`${packageName} has no matching ${crateName} package in Cargo.lock.`);
    } else if (jsVersion !== rustVersion) {
      issues.push(
        `${packageName} (${jsVersion}) does not match ${crateName} in Cargo.lock (${rustVersion}).`
      );
    }
  }

  return issues;
};

export const readPackageVersion = () => {
  const packageJson = readPackageJson();
  return assertValidSemver(packageJson.version);
};

export const writePackageVersion = (version) => {
  const packageJson = readPackageJson();
  packageJson.version = assertValidSemver(version);
  writeTextFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`);
};

export const getCargoPackageVersion = (content) => {
  const match = content.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);

  if (!match) {
    throw new Error('Unable to locate [package] version in Cargo.toml');
  }

  return match[1];
};

export const updateCargoPackageVersion = (content, version) => {
  const nextVersion = assertValidSemver(version);
  const pattern = /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m;

  if (!pattern.test(content)) {
    throw new Error('Unable to locate [package] version in Cargo.toml');
  }

  return content.replace(pattern, `$1${nextVersion}$2`);
};

export const getCargoLockPackageVersion = (content, packageName = CARGO_PACKAGE_NAME) => {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(
    new RegExp(
      `^\\[\\[package\\]\\]\\s*$[\\s\\S]*?^name\\s*=\\s*"${escapedPackageName}"\\s*$[\\s\\S]*?^version\\s*=\\s*"([^"]+)"`,
      'm'
    )
  );

  if (!match) {
    throw new Error(`Unable to locate ${packageName} package version in Cargo.lock`);
  }

  return match[1];
};

export const updateCargoLockPackageVersion = (content, version, packageName = CARGO_PACKAGE_NAME) => {
  const nextVersion = assertValidSemver(version);
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(^\\[\\[package\\]\\]\\s*$[\\s\\S]*?^name\\s*=\\s*"${escapedPackageName}"\\s*$[\\s\\S]*?^version\\s*=\\s*")[^"]+(")`,
    'm'
  );

  if (!pattern.test(content)) {
    throw new Error(`Unable to locate ${packageName} package version in Cargo.lock`);
  }

  return content.replace(pattern, `$1${nextVersion}$2`);
};

export const syncVersionFiles = (version) => {
  const nextVersion = assertValidSemver(version);
  const updatedFiles = [];

  const cargoContent = readTextFile(CARGO_TOML_PATH);
  const nextCargoContent = updateCargoPackageVersion(cargoContent, nextVersion);
  if (nextCargoContent !== cargoContent) {
    writeTextFile(CARGO_TOML_PATH, nextCargoContent);
    updatedFiles.push(CARGO_TOML_PATH);
  }

  const cargoLockContent = readTextFile(CARGO_LOCK_PATH);
  const nextCargoLockContent = updateCargoLockPackageVersion(cargoLockContent, nextVersion);
  if (nextCargoLockContent !== cargoLockContent) {
    writeTextFile(CARGO_LOCK_PATH, nextCargoLockContent);
    updatedFiles.push(CARGO_LOCK_PATH);
  }

  const tauriConfig = JSON.parse(readTextFile(TAURI_CONF_PATH));
  if (tauriConfig.version !== TAURI_PACKAGE_VERSION_REFERENCE) {
    tauriConfig.version = TAURI_PACKAGE_VERSION_REFERENCE;
    writeTextFile(TAURI_CONF_PATH, `${JSON.stringify(tauriConfig, null, 2)}\n`);
    updatedFiles.push(TAURI_CONF_PATH);
  }

  return updatedFiles;
};

export const readVersionState = () => {
  const packageJson = readPackageJson();
  const packageVersion = assertValidSemver(packageJson.version);
  const cargoToml = readTextFile(CARGO_TOML_PATH);
  const cargoLock = readTextFile(CARGO_LOCK_PATH);
  const cargoVersion = getCargoPackageVersion(cargoToml);
  const cargoLockVersion = getCargoLockPackageVersion(cargoLock);
  const tauriConfig = JSON.parse(readTextFile(TAURI_CONF_PATH));
  const flakeNix = readTextFile(FLAKE_NIX_PATH);
  const settingsModal = readTextFile(SETTINGS_MODAL_PATH);

  const issues = [];

  issues.push(...getTauriDependencyIssues(packageJson, cargoLock));

  if (cargoVersion !== packageVersion) {
    issues.push(
      `Cargo.toml version (${cargoVersion}) does not match package.json version (${packageVersion}).`
    );
  }

  if (cargoLockVersion !== packageVersion) {
    issues.push(
      `Cargo.lock package version (${cargoLockVersion}) does not match package.json version (${packageVersion}).`
    );
  }

  if (tauriConfig.version !== TAURI_PACKAGE_VERSION_REFERENCE) {
    issues.push(
      `tauri.conf.json version must be "${TAURI_PACKAGE_VERSION_REFERENCE}", received "${String(tauriConfig.version)}".`
    );
  }

  if (!FLAKE_PACKAGE_JSON_REGEX.test(flakeNix) || !FLAKE_VERSION_ASSIGNMENT_REGEX.test(flakeNix)) {
    issues.push('flake.nix must derive its package version from package.json.');
  }

  if (FLAKE_HARDCODED_VERSION_REGEX.test(flakeNix)) {
    issues.push('flake.nix still contains a hardcoded package version.');
  }

  if (!settingsModal.includes('useAppVersion')) {
    issues.push('SettingsModal.tsx must read the app version from the shared app-version layer.');
  }

  if (HARD_CODED_BUILD_REGEX.test(settingsModal)) {
    issues.push('SettingsModal.tsx still contains a hardcoded build label.');
  }

  if (HARD_CODED_SEMVER_REGEX.test(settingsModal)) {
    issues.push('SettingsModal.tsx still contains a hardcoded semver literal.');
  }

  return {
    packageVersion,
    cargoVersion,
    cargoLockVersion,
    tauriVersion: tauriConfig.version,
    issues,
  };
};
