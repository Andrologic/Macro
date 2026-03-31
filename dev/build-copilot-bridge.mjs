import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const entry = resolve(root, 'copilot-bridge', 'src', 'index.ts');
const binariesDir = resolve(root, 'src-tauri', 'binaries');
const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';

const TARGETS = {
  'darwin:arm64': {
    bunTarget: 'bun-darwin-arm64',
    tauriTriple: 'aarch64-apple-darwin',
    extension: '',
  },
  'darwin:x64': {
    bunTarget: 'bun-darwin-x64',
    tauriTriple: 'x86_64-apple-darwin',
    extension: '',
  },
  'linux:x64': {
    bunTarget: 'bun-linux-x64',
    tauriTriple: 'x86_64-unknown-linux-gnu',
    extension: '',
  },
  'linux:arm64': {
    bunTarget: 'bun-linux-arm64',
    tauriTriple: 'aarch64-unknown-linux-gnu',
    extension: '',
  },
  'win32:x64': {
    bunTarget: 'bun-windows-x64',
    tauriTriple: 'x86_64-pc-windows-msvc',
    extension: '.exe',
  },
  'win32:arm64': {
    bunTarget: 'bun-windows-arm64',
    tauriTriple: 'aarch64-pc-windows-msvc',
    extension: '.exe',
  },
};

const forcedTarget = process.env.MACRO_COPILOT_BRIDGE_TARGET?.trim();
const targetKey = forcedTarget || `${process.platform}:${process.arch}`;
const target = TARGETS[targetKey];

if (!target) {
  throw new Error(`Unsupported Macro Copilot bridge target: ${targetKey}`);
}

const output = resolve(
  binariesDir,
  `macro-copilot-bridge-${target.tauriTriple}${target.extension}`
);

await mkdir(dirname(output), { recursive: true });

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
      resolvePromise();
      return;
    }
    rejectPromise(new Error(`bun build --compile failed with exit code ${code ?? -1}`));
  });
  child.on('error', rejectPromise);
});
