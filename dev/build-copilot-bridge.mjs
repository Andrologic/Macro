import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const entry = resolve(root, 'copilot-bridge', 'src', 'index.ts');
const baseOutput = resolve(root, 'src-tauri', 'resources', 'macro-copilot-bridge');
const output = process.platform === 'win32' ? `${baseOutput}.exe` : baseOutput;
const bunExecutable = process.platform === 'win32' ? 'bun.exe' : 'bun';

await mkdir(dirname(output), { recursive: true });

const child = spawn(
  bunExecutable,
  ['build', entry, '--compile', '--outfile', output],
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
