#!/usr/bin/env bun
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 2) throw new Error('This command takes no relay, credentials, or other arguments.');
const root = fileURLToPath(new URL('../', import.meta.url));
const child = Bun.spawn([process.execPath, '--no-install', 'dev/run-tests.mjs', '--only',
  'src/services/macroPilot/syntheticFlows.test.ts'], {
  cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdout: 'inherit', stderr: 'inherit',
});
process.exitCode = await child.exited;
