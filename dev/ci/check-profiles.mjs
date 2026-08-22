const step = (name, command, args) => ({ name, command, args });

const repositoryChecks = [
  step('Check version manifests', 'bun', ['dev/version/check.mjs']),
  step('Reject generated binaries', 'bun', ['dev/check-git-binaries.mjs']),
  step('Check Tauri updater configuration', 'bun', ['dev/release/updater-preflight.mjs']),
];

const installStep = step('Install locked frontend dependencies', 'bun', ['install', '--frozen-lockfile']);
const workflowStep = step('Validate GitHub workflows', 'bun', ['dev/ci/validate-workflows.mjs']);

const frontendChecks = [
  step('Typecheck frontend', 'bun', ['run', 'typecheck']),
  step('Lint frontend', 'bun', ['run', 'lint']),
  step('Audit translations', 'bun', ['run', 'i18n:audit']),
  step('Run frontend tests', 'bun', ['run', 'test']),
  step('Build frontend', 'bun', ['run', 'build:vite']),
  step('Check bundle budgets', 'bun', ['run', 'bundle:check']),
];

const nativeChecks = [
  step('Build AI runtime sidecar', 'bun', ['run', 'build:ai-runtime']),
  step('Run locked Rust tests', 'cargo', [
    'test',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--locked',
    '--',
    '--test-threads=1',
  ]),
  step('Check headless example', 'cargo', [
    'check',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--example',
    'macro-headless',
    '--locked',
  ]),
];

const windowsNativeCheck = step('Check all Windows native targets', 'cargo', [
  'check',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--locked',
  '--all-targets',
]);

export const CHECK_PROFILES = Object.freeze([
  'documentation',
  'frontend',
  'native',
  'windows',
  'full',
]);

export function stepsForProfile(profile, options = {}) {
  const platform = options.platform || process.platform;
  const skipInstall = options.skipInstall === true;
  const install = skipInstall ? [] : [installStep];

  switch (profile) {
    case 'documentation':
      return [...repositoryChecks];
    case 'frontend':
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks];
    case 'native':
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks, ...nativeChecks];
    case 'windows':
      return [...install, workflowStep, ...repositoryChecks, nativeChecks[0], windowsNativeCheck];
    case 'full': {
      const platformChecks = platform === 'win32' ? [windowsNativeCheck] : [];
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks, ...nativeChecks, ...platformChecks];
    }
    default:
      throw new Error(`Unknown CI profile "${profile}". Expected one of: ${CHECK_PROFILES.join(', ')}.`);
  }
}

export function profileForClassification(classification) {
  if (classification.documentation_only) {
    return 'documentation';
  }
  if (classification.native || classification.configuration) {
    return 'full';
  }
  if (classification.frontend) {
    return 'frontend';
  }
  return 'full';
}
