#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repositoryRoot, 'src-tauri', 'Cargo.toml');
const executableName = process.platform === 'win32' ? 'macro-headless.exe' : 'macro-headless';
const executablePath = path.join(
  repositoryRoot,
  'src-tauri',
  'target',
  'debug',
  'examples',
  executableName,
);

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Expected a TCP address.');
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function runBuild() {
  const buildEnvironment = {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }),
  };
  const processHandle = Bun.spawn([
    'cargo',
    'build',
    '--manifest-path',
    manifestPath,
    '--example',
    'macro-headless',
  ], {
    cwd: repositoryRoot,
    env: buildEnvironment,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await processHandle.exited;
  if (exitCode !== 0) {
    throw new Error(`Headless smoke build failed with exit code ${exitCode}.`);
  }
}

async function waitForServer(url, processHandle, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processHandle.exitCode != null) {
      throw new Error(`macro-headless exited before accepting requests (${processHandle.exitCode}).`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response) return;
    } catch {
      // The listener may still be starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`macro-headless did not start within ${timeoutMs} ms.`);
}

async function stopProcess(processHandle) {
  if (processHandle.exitCode != null) return;
  processHandle.kill('SIGTERM');
  const stopped = await Promise.race([
    processHandle.exited.then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  if (!stopped && processHandle.exitCode == null) {
    processHandle.kill('SIGKILL');
    await processHandle.exited;
  }
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'macro-headless-smoke-'));
  const configRoot = path.join(temporaryRoot, 'config');
  const workspaceRoot = path.join(temporaryRoot, 'workspace');
  const bearerToken = 'macro-smoke-agent-token';
  const approvalToken = 'macro-smoke-approval-token';
  let processHandle = null;

  try {
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
    ]);
    await writeFile(path.join(configRoot, 'runtime.json'), `${JSON.stringify({
      $schema: './schemas/v1/runtime.schema.json',
      schemaVersion: 1,
      allowedRoots: [workspaceRoot],
      headless: { bindAddress: '127.0.0.1', autoStart: false },
    }, null, 2)}\n`);

    await runBuild();
    const port = await reserveLoopbackPort();
    const environment = {
      ...process.env,
      MACRO_CONFIG_DIR: configRoot,
      MACRO_HEADLESS_HOST: '127.0.0.1',
      MACRO_HEADLESS_PORT: String(port),
      MACRO_HEADLESS_BEARER_TOKEN: bearerToken,
      MACRO_HEADLESS_APPROVAL_TOKEN: approvalToken,
      RUST_LOG: 'warn',
    };
    delete environment.MACRO_CONFIG;

    processHandle = Bun.spawn([executablePath], {
      cwd: workspaceRoot,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new Response(processHandle.stdout).text();
    const stderr = new Response(processHandle.stderr).text();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForServer(`${baseUrl}/health`, processHandle);

      const unauthorized = await fetch(`${baseUrl}/health`);
      assert.equal(unauthorized.status, 401, 'Health must reject a missing bearer token.');

      const invalidBearer = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: 'Bearer invalid-smoke-token' },
      });
      assert.equal(invalidBearer.status, 401, 'Health must reject an invalid bearer token.');

      const headers = { Authorization: `Bearer ${bearerToken}` };
      const health = await fetch(`${baseUrl}/health`, { headers });
      assert.equal(health.status, 200, 'Authorized health request must succeed.');
      assert.deepEqual(await health.json(), { status: 'ok', service: 'macro-headless' });

      const agentApproval = await fetch(`${baseUrl}/api/v1/config/pending/accept`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'nonexistent-smoke-change' }),
      });
      assert.equal(
        agentApproval.status,
        401,
        'The ordinary agent bearer must not authorize a sensitive configuration decision.',
      );

      const bootstrap = await fetch(`${baseUrl}/api/v1/workspace/bootstrap`, { headers });
      assert.equal(bootstrap.status, 200, 'Workspace bootstrap must cross the HTTP/backend boundary.');
      const payload = await bootstrap.json();
      assert.equal(payload.plan, null);
      for (const key of ['standaloneProjects', 'projectGroups', 'planNodes', 'predictedBranches']) {
        assert(Array.isArray(payload[key]), `Workspace bootstrap field "${key}" must be an array.`);
      }

      console.log(`Headless smoke passed on ${baseUrl}.`);
    } catch (error) {
      await stopProcess(processHandle);
      const [capturedStdout, capturedStderr] = await Promise.all([stdout, stderr]);
      const diagnostics = [capturedStdout, capturedStderr].filter(Boolean).join('\n').trim();
      if (diagnostics) console.error(diagnostics);
      throw error;
    }

    await stopProcess(processHandle);
    await Promise.all([stdout, stderr]);
  } finally {
    if (processHandle) await stopProcess(processHandle);
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

await main();
