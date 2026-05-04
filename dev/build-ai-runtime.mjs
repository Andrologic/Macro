import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const entry = resolve(root, 'copilot-bridge', 'src', 'index.ts');
const binariesDir = resolve(root, 'src-tauri', 'binaries');
const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';
const OUTPUT_BASENAME = 'macro-ai-runtime';
const LEGACY_OUTPUT_BASENAME = 'macro-copilot-bridge';

const TARGETS = {
  'aarch64-apple-darwin': {
    bunTarget: 'bun-darwin-arm64',
    tauriTriple: 'aarch64-apple-darwin',
    extension: '',
  },
  'x86_64-apple-darwin': {
    bunTarget: 'bun-darwin-x64',
    tauriTriple: 'x86_64-apple-darwin',
    extension: '',
  },
  'x86_64-unknown-linux-gnu': {
    bunTarget: 'bun-linux-x64',
    tauriTriple: 'x86_64-unknown-linux-gnu',
    extension: '',
  },
  'aarch64-unknown-linux-gnu': {
    bunTarget: 'bun-linux-arm64',
    tauriTriple: 'aarch64-unknown-linux-gnu',
    extension: '',
  },
  'x86_64-pc-windows-msvc': {
    bunTarget: 'bun-windows-x64',
    tauriTriple: 'x86_64-pc-windows-msvc',
    extension: '.exe',
  },
  'aarch64-pc-windows-msvc': {
    bunTarget: 'bun-windows-arm64',
    tauriTriple: 'aarch64-pc-windows-msvc',
    extension: '.exe',
  },
};

const HOST_TARGET_KEYS = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'win32:arm64': 'aarch64-pc-windows-msvc',
};

const TARGET_ALIASES = {
  ...HOST_TARGET_KEYS,
  arm64: 'aarch64-apple-darwin',
  aarch64: 'aarch64-apple-darwin',
  x64: 'x86_64-apple-darwin',
  x86_64: 'x86_64-apple-darwin',
};

const resolveTargetKey = () => {
  const requestedTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE?.trim() ||
    process.env.MACRO_AI_RUNTIME_TARGET?.trim() ||
    process.env.MACRO_COPILOT_BRIDGE_TARGET?.trim();

  if (requestedTarget) {
    return TARGET_ALIASES[requestedTarget] || requestedTarget;
  }

  const hostKey = `${process.platform}:${process.arch}`;
  return HOST_TARGET_KEYS[hostKey] || hostKey;
};

const targetKey = resolveTargetKey();
const target = TARGETS[targetKey];

if (!target) {
  throw new Error(
    `Unsupported Macro AI runtime target "${targetKey}". Supported targets: ${Object.keys(TARGETS).join(', ')}.`
  );
}

const output = resolve(
  binariesDir,
  `${OUTPUT_BASENAME}-${target.tauriTriple}${target.extension}`
);
const legacyOutput = resolve(
  binariesDir,
  `${LEGACY_OUTPUT_BASENAME}-${target.tauriTriple}${target.extension}`
);

await mkdir(dirname(output), { recursive: true });
await rm(output, { force: true });
await rm(legacyOutput, { force: true });

const child = spawn(
  bunExecutable,
  ['build', entry, '--compile', `--target=${target.bunTarget}`, '--outfile', output],
  {
    cwd: root,
    stdio: 'inherit',
  }
);

await new Promise((resolvePromise, rejectPromise) => {
  child.on('exit', (code) => {
    if (code === 0) {
      console.log(`Built ${output} for ${target.tauriTriple} using ${target.bunTarget}.`);
      resolvePromise();
      return;
    }
    rejectPromise(new Error(`bun build --compile failed with exit code ${code ?? -1}`));
  });
  child.on('error', rejectPromise);
});
