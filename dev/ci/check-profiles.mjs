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

const sidecarCheck = step('Build AI runtime sidecar', 'bun', ['run', 'build:ai-runtime']);
const rustTestCheck = step('Run locked Rust tests for all targets', 'cargo', [
  'test',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--locked',
  '--all-targets',
  '--',
  '--test-threads=1',
]);
const nativeChecks = [sidecarCheck, rustTestCheck];

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
  'native-core',
  'sidecar',
  'windows',
  'windows-core',
  'full',
]);

export function stepsForProfile(profile, options = {}) {
  const skipInstall = options.skipInstall === true;
  const install = skipInstall ? [] : [installStep];

  switch (profile) {
    case 'documentation':
      return [...repositoryChecks];
    case 'frontend':
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks];
    case 'native':
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks, ...nativeChecks];
    case 'native-core':
      return [...repositoryChecks, rustTestCheck];
    case 'sidecar':
      return [...install, sidecarCheck];
    case 'windows':
      return [...install, workflowStep, ...repositoryChecks, sidecarCheck, windowsNativeCheck];
    case 'windows-core':
      return [...repositoryChecks, windowsNativeCheck];
    case 'full': {
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks, ...nativeChecks];
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
