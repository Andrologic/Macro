import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateQaBrowserRuntimeConfig } from './browser-runtime-config.mjs';

const token = randomBytes(32).toString('hex');
const customConfig = process.env.MACRO_TAURI_BROWSER_CONFIG;
const configPath = customConfig
  ? resolve(customConfig)
  : 'src-tauri/tauri.browser-debug.conf.json';
if (customConfig) {
  validateQaBrowserRuntimeConfig(JSON.parse(readFileSync(configPath, 'utf8')));
}
const child = Bun.spawn(
  [
    'bun',
    'dev/tauri-cli.mjs',
    'dev',
    '--features',
    'browser-runtime-debug',
    '--config',
    configPath,
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
