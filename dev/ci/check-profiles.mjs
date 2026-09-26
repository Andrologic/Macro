const step = (name, command, args) => ({ name, command, args });

const repositoryChecks = [
  step('Check version manifests', 'bun', ['dev/version/check.mjs']),
  step('Reject generated binaries', 'bun', ['dev/check-git-binaries.mjs']),
  step('Check Tauri updater configuration', 'bun', ['dev/release/updater-preflight.mjs']),
];

const installStep = step('Install locked frontend dependencies', 'bun', ['install', '--frozen-lockfile']);
const workflowStep = step('Validate GitHub workflows', 'bun', ['dev/ci/validate-workflows.mjs']);
const architectureCheck = step('Check domain import boundaries', 'bun', ['run', 'architecture:check']);
const copilotTypecheck = step('Typecheck Copilot bridge', 'bun', ['run', 'typecheck:copilot']);

const frontendChecks = [
  architectureCheck,
  step('Typecheck frontend', 'bun', ['run', 'typecheck']),
  copilotTypecheck,
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
const rustDocTestCheck = step('Run locked Rust doc tests', 'cargo', [
  'test',
  '--manifest-path',
  'src-tauri/Cargo.toml',
  '--locked',
  '--doc',
]);
const generatedContractChecks = ['config', 'ipc'].map((domain) => step(
  `Check generated ${domain} contracts`, 'cargo', [
    'run', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--jobs', '2',
    '--example', 'generate_config', '--', '--domain', domain, '--check',
  ],
));
const nativeChecks = [sidecarCheck, ...generatedContractChecks, rustTestCheck, rustDocTestCheck];

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
      return [...install, ...repositoryChecks, architectureCheck, copilotTypecheck, sidecarCheck, ...generatedContractChecks, rustTestCheck, rustDocTestCheck];
    case 'sidecar':
      return [...install, copilotTypecheck, sidecarCheck];
    case 'windows':
      return [...install, workflowStep, ...repositoryChecks, architectureCheck, copilotTypecheck, sidecarCheck, ...generatedContractChecks, windowsNativeCheck];
    case 'windows-core':
      return [...install, ...repositoryChecks, architectureCheck, copilotTypecheck, sidecarCheck, ...generatedContractChecks, windowsNativeCheck];
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
