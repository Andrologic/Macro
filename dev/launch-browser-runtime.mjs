import { randomBytes } from 'node:crypto';

const token = randomBytes(32).toString('hex');
const child = Bun.spawn(
  [
    'bun',
    'dev/tauri-cli.mjs',
    'dev',
    '--features',
    'browser-runtime-debug',
    '--config',
    'src-tauri/tauri.browser-debug.conf.json',
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MACRO_TAURI_BROWSER_BRIDGE: '1',
      MACRO_TAURI_BROWSER_BRIDGE_TOKEN: token,
      VITE_TAURI_BROWSER_BRIDGE: '1',
      VITE_TAURI_BROWSER_BRIDGE_TOKEN: token,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

const forwardSignal = (signal) => {
  try {
    child.kill(signal);
  } catch {
    // Le processus peut s'être déjà arrêté.
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.exitCode = await child.exited;
