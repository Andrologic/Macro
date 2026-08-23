import { dirname, posix } from 'node:path';

const TYPESCRIPT_PATTERN = /\.(?:ts|tsx)$/;
const LINTABLE_SCRIPT_PATTERN = /\.(?:[cm]?[jt]s|jsx|tsx)$/;
const TEST_PATTERN = /\.test\.(?:ts|tsx)$/;
const RUST_PATTERN = /\.rs$/;

const WORKFLOW_PATTERNS = [
  /^\.github\/(?:workflows|actions)\//,
  /^\.githooks\//,
  /^dev\/ci\//,
  /^package\.json$/,
];

const DEPENDENCY_PATTERNS = [
  /^(?:package\.json|bun\.lock|bunfig\.toml)$/,
];

const UPDATER_PATTERNS = [
  /^package\.json$/,
  /^src-tauri\/(?:Cargo\.toml|Cargo\.lock|tauri(?:\.local)?\.conf\.json)$/,
  /^src-tauri\/capabilities\/default\.json$/,
  /^dev\/release\/(?:updater-preflight|verify-updater)(?:\.test)?\.mjs$/,
];

const I18N_PATTERNS = [
  /^src\/i18n\//,
  /^dev\/i18n\//,
];

export function normalizePath(path) {
  return path.replace(/^\.\//, '').replaceAll('\\', '/');
}

export function normalizePaths(paths) {
  return [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

export function selectLintFiles(paths, exists = () => true) {
  return normalizePaths(paths)
    .filter((path) => LINTABLE_SCRIPT_PATTERN.test(path) && exists(path));
}

function sourceKeys(path) {
  const normalized = normalizePath(path).replace(/\.(?:ts|tsx)$/, '');
  const keys = new Set([normalized]);
  if (normalized.endsWith('/index')) {
    keys.add(normalized.slice(0, -'/index'.length));
  }
  return keys;
}

function importedSourceKeys(testFile, source) {
  if (!source.startsWith('.')) {
    return [];
  }
  return sourceKeys(posix.normalize(posix.join(dirname(testFile).replaceAll('\\', '/'), source)));
}

export function relativeImports(source) {
  const imports = new Set();
  const pattern = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    imports.add(match[1]);
  }
  return [...imports];
}

export function selectRelatedTestFiles({
  changedPaths,
  testFiles,
  exists = () => true,
  readFile = () => '',
}) {
  const changed = normalizePaths(changedPaths).filter((path) => exists(path));
  const availableTests = normalizePaths(testFiles).filter((path) => exists(path));
  const availableSet = new Set(availableTests);
  const selected = new Set(changed.filter((path) => TEST_PATTERN.test(path) && availableSet.has(path)));
  const changedSources = changed.filter((path) => TYPESCRIPT_PATTERN.test(path) && !TEST_PATTERN.test(path));
  const changedKeys = new Set(changedSources.flatMap((path) => [...sourceKeys(path)]));

  for (const source of changedSources) {
    const withoutExtension = source.replace(/\.(?:ts|tsx)$/, '');
    for (const candidate of [`${withoutExtension}.test.ts`, `${withoutExtension}.test.tsx`]) {
      if (availableSet.has(candidate)) {
        selected.add(candidate);
      }
    }
  }

  if (changedKeys.size > 0) {
    for (const testFile of availableTests) {
      if (selected.has(testFile)) {
        continue;
      }
      const imports = relativeImports(readFile(testFile));
      if (imports.some((source) => [...importedSourceKeys(testFile, source)].some((key) => changedKeys.has(key)))) {
        selected.add(testFile);
      }
    }
  }

  return [...selected].sort();
}

export function planFastLocalChecks(paths, options = {}) {
  const normalized = normalizePaths(paths);
  const exists = options.exists || (() => true);
  const lintFiles = selectLintFiles(normalized, exists);
  const testFiles = selectRelatedTestFiles({
    changedPaths: normalized,
    testFiles: options.testFiles || [],
    exists,
    readFile: options.readFile,
  });
  const steps = [
    { name: 'Versions cohérentes', command: process.execPath, args: ['dev/version/check.mjs'] },
    { name: 'Binaires suivis autorisés', command: process.execPath, args: ['dev/check-git-binaries.mjs'] },
  ];

  if (normalized.some((path) => matchesAny(path, DEPENDENCY_PATTERNS))) {
    steps.push({
      name: 'Verrouillage des dépendances cohérent',
      command: process.execPath,
      args: ['install', '--frozen-lockfile', '--lockfile-only', '--dry-run'],
      quiet: true,
    });
  }
  if (normalized.some((path) => matchesAny(path, WORKFLOW_PATTERNS))) {
    steps.push({ name: 'Workflows GitHub valides', command: process.execPath, args: ['dev/ci/validate-workflows.mjs'] });
  }
  if (normalized.some((path) => matchesAny(path, UPDATER_PATTERNS))) {
    steps.push({ name: 'Configuration updater cohérente', command: process.execPath, args: ['dev/release/updater-preflight.mjs'] });
  }
  if (normalized.some((path) => matchesAny(path, I18N_PATTERNS))) {
    steps.push({ name: 'Traductions cohérentes', command: process.execPath, args: ['dev/i18n/audit.mjs'] });
  }
  if (lintFiles.length > 0) {
    steps.push({
      name: `ESLint ciblé (${lintFiles.length} fichier${lintFiles.length > 1 ? 's' : ''})`,
      command: process.execPath,
      args: ['node_modules/eslint/bin/eslint.js', ...lintFiles],
      needsDependencies: true,
    });
  }
  if (testFiles.length > 0) {
    steps.push({
      name: `Tests liés (${testFiles.length} fichier${testFiles.length > 1 ? 's' : ''})`,
      command: process.execPath,
      args: ['dev/run-tests.mjs', ...testFiles.flatMap((path) => ['--only', path])],
      needsDependencies: true,
    });
  }
  if (normalized.some((path) => path.startsWith('src-tauri/') && RUST_PATTERN.test(path) && exists(path))) {
    steps.push({
      name: 'Formatage Rust',
      command: 'cargo',
      args: ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check'],
    });
  }

  return { paths: normalized, lintFiles, testFiles, steps };
}
