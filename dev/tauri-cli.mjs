import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const tauriCli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);

try {
  await access(tauriCli);
} catch {
  console.error('Tauri CLI is not installed. Run `bun install` before running Macro Tauri commands.');
  process.exit(1);
}

const isBuildCommand = args[0] === 'build';
const hasExplicitBundleTarget = args.some(
  (arg, index) =>
    arg === '--bundles' ||
    arg === '-b' ||
    arg.startsWith('--bundles=') ||
    (args[index - 1] === '--bundles' || args[index - 1] === '-b')
);
const isWindowsPrerelease =
  process.platform === 'win32' && /-\w+(?:[.-]\w+)*$/.test(packageJson.version);

const finalArgs = [...args];

if (isBuildCommand && isWindowsPrerelease && !hasExplicitBundleTarget) {
  finalArgs.push('--bundles', 'nsis');
  console.log(
    `Macro ${packageJson.version}: Windows MSI does not accept prerelease versions; building the NSIS installer instead.`
  );
}

const env = { ...process.env };
if (isBuildCommand && !env.NODE_ENV) {
  env.NODE_ENV = 'production';
}

const child = spawn(process.execPath, [tauriCli, ...finalArgs], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
