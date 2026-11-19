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
const argenticScript = 'dev/ci/argentic.mjs';
const rustTestCheck = step('Run locked Rust tests for all targets', 'bun', [
  argenticScript, 'macro', 'test',
  '--locked',
  '--features', 'performance-sqlite',
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
// Check the same standalone workspaces that Cargo resolves for Macro.
const argenticChecks = ['argentic-core', 'argentic-runtime'].flatMap((crate) => [
  step(`Run locked ${crate} tests for all targets`, 'bun', [
    argenticScript, crate, 'test', '--locked', '--all-targets', '--', '--test-threads=1',
  ]),
  step(`Run locked ${crate} doc tests`, 'bun', [
    argenticScript, crate, 'test', '--locked', '--doc',
  ]),
]);
argenticChecks.push(
  step('Build standalone Argentic host', 'bun', [
    argenticScript, 'argentic-runtime', 'build', '--locked', '--example', 'argentic-host',
  ]),
  step('Verify native approval boundary', 'bun', [
    argenticScript, 'argentic-runtime', 'test', '--locked', '--features', 'dev-support',
    '--test', 'approval_boundary', '--', '--test-threads=1',
  ]),
);
const argenticWindowsChecks = ['argentic-core', 'argentic-runtime'].map((crate) =>
  step(`Check ${crate} Windows targets`, 'bun', [
    argenticScript, crate, 'check', '--locked', '--all-targets',
  ]),
);
const processRecoveryCheck = step('Verify native process interruption recovery', 'bun', ['run', 'test:native:process-recovery']);
const headlessHttpCheck = step('Verify headless HTTP transport', 'bun', ['run', 'test:e2e:headless']);
const nativeChecks = [sidecarCheck, ...generatedContractChecks, ...argenticChecks, rustTestCheck, rustDocTestCheck, headlessHttpCheck];

const windowsNativeCheck = step('Check all Windows native targets', 'bun', [
  argenticScript, 'macro', 'check',
  '--locked',
  '--features', 'performance-sqlite',
  '--all-targets',
]);

export const CHECK_PROFILES = Object.freeze([
  'documentation',
  'argentic',
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
  const processRecovery = (options.platform ?? process.platform) === 'linux' ? [processRecoveryCheck] : [];

  switch (profile) {
    case 'argentic':
      return [...argenticChecks];
    case 'documentation':
      return [...repositoryChecks];
    case 'frontend':
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks];
    case 'native':
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks, ...nativeChecks, ...processRecovery];
    case 'native-core':
      return [...install, ...repositoryChecks, architectureCheck, copilotTypecheck, sidecarCheck, ...generatedContractChecks, ...argenticChecks, rustTestCheck, rustDocTestCheck, headlessHttpCheck, ...processRecovery];
    case 'sidecar':
      return [...install, copilotTypecheck, sidecarCheck];
    case 'windows':
      return [...install, workflowStep, ...repositoryChecks, architectureCheck, copilotTypecheck, sidecarCheck, ...generatedContractChecks, ...argenticWindowsChecks, windowsNativeCheck, headlessHttpCheck];
    case 'windows-core':
      return [...install, ...repositoryChecks, architectureCheck, copilotTypecheck, sidecarCheck, ...generatedContractChecks, ...argenticWindowsChecks, windowsNativeCheck, headlessHttpCheck];
    case 'full': {
      return [...install, workflowStep, ...repositoryChecks, ...frontendChecks, ...nativeChecks, ...processRecovery];
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
