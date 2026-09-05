import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  resolveQaBrowserLogDirectory,
  validateQaBrowserRuntimeConfig,
} from './browser-runtime-config.mjs';

const token = randomBytes(32).toString('hex');
const customConfig = process.env.MACRO_TAURI_BROWSER_CONFIG;
const configPath = customConfig
  ? resolve(customConfig)
  : resolve('src-tauri/tauri.browser-debug.conf.json');
const runtimeConfig = validateQaBrowserRuntimeConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const logDirectory = resolveQaBrowserLogDirectory(runtimeConfig, tmpdir());
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
      MACRO_TAURI_BROWSER_LOG_DIR: logDirectory,
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
