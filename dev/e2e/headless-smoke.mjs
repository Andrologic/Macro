#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  const projectRoot = path.join(workspaceRoot, 'project-smoke');
  const addedProjectRoot = path.join(workspaceRoot, 'project-added-after-start');
  const workspaceMetadataRoot = path.join(workspaceRoot, '.macro');
  const workspaceStatePath = path.join(workspaceMetadataRoot, 'workspace.json');
  const workspaceId = 'workspace-smoke';
  const bearerToken = 'macro-smoke-agent-token';
  const approvalToken = 'macro-smoke-approval-token';
  const crashedExecutionId = 'crashed-smoke-mutation';
  let processHandle = null;

  try {
    await Promise.all([
      mkdir(configRoot, { recursive: true }),
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(addedProjectRoot, { recursive: true }),
      mkdir(workspaceMetadataRoot, { recursive: true }),
    ]);
    const project = (id, name, projectPath, userReadOnly = false) => ({
      id,
      name,
      mountName: name,
      path: projectPath,
      created_at: '2026-09-06T00:00:00.000Z',
      status: 'active',
      userReadOnly,
      directEdit: true,
      gitSetupState: 'not_git',
      isReadOnly: userReadOnly,
      metadata: {
        description: '',
        tags: [],
        team_members: [],
        api_contracts: [],
        dependencies: [],
      },
    });
    const workspaceState = (projects, revision) => ({
      version: 4,
      workspaceRevision: revision,
      standaloneProjects: projects,
      projectRegistryExplicitlyEmpty: false,
      projectGroups: [],
    });
    const initialProject = project('project-smoke', 'smoke', projectRoot);
    const projectToolsConfig = (projectPath, projectId) =>
      path.join(projectPath, '.macro', 'projects', projectId, 'config');
    const initialToolsConfig = projectToolsConfig(projectRoot, 'project-smoke');
    const addedToolsConfig = projectToolsConfig(addedProjectRoot, 'project-added');
    await Promise.all([
      mkdir(initialToolsConfig, { recursive: true }),
      mkdir(addedToolsConfig, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(workspaceRoot, 'marker.txt'), 'wrong workspace root'),
      writeFile(path.join(projectRoot, 'marker.txt'), 'focused project marker'),
      writeFile(path.join(projectRoot, 'large.txt'), 'x'.repeat(1_228_800)),
      writeFile(
        path.join(initialToolsConfig, 'tools.json'),
        '{"$schema":"./schemas/v1/tools.schema.json","schemaVersion":1}\n',
      ),
      writeFile(
        path.join(addedToolsConfig, 'tools.json'),
        '{"$schema":"./schemas/v1/tools.schema.json","schemaVersion":1}\n',
      ),
      writeFile(
        workspaceStatePath,
        `${JSON.stringify(workspaceState([initialProject], 1), null, 2)}\n`,
      ),
    ]);
    await writeFile(path.join(configRoot, 'runtime.json'), `${JSON.stringify({
      $schema: './schemas/v1/runtime.schema.json',
      schemaVersion: 1,
      allowedRoots: [workspaceRoot],
      headless: { bindAddress: '127.0.0.1', autoStart: false },
    }, null, 2)}\n`);
    const journalRoot = path.join(configRoot, 'headless-tool-executions');
    await mkdir(journalRoot, { recursive: true });
    const canonicalAddedProjectRoot = await realpath(addedProjectRoot);
    const crashedMutation = {
      mode: 'Implement',
      tool_id: 'write',
      args: {
        content: 'must never be written',
        expected_revision: 'absent',
        path: 'crash-probe.txt',
      },
      execution_id: crashedExecutionId,
      workspace_path: canonicalAddedProjectRoot,
      workspace_scope: null,
      project_mounts: null,
      virtual_root_enabled: null,
      focused_project_id: 'project-added',
      checkpoint_required: false,
    };
    const crashedMutationFingerprint = createHash('sha256')
      .update(JSON.stringify(crashedMutation))
      .digest('hex');
    const crashedRecordName = `${createHash('sha256').update(crashedExecutionId).digest('hex')}.pending.json`;
    await writeFile(path.join(journalRoot, crashedRecordName), JSON.stringify({
      schema_version: 1,
      execution_id: crashedExecutionId,
      fingerprint: crashedMutationFingerprint,
      state: { status: 'pending' },
    }));

    await runBuild();
    const port = await reserveLoopbackPort();
    const environment = {
      ...process.env,
      MACRO_CONFIG_DIR: configRoot,
      MACRO_HEADLESS_HOST: '127.0.0.1',
      MACRO_HEADLESS_PORT: String(port),
      MACRO_HEADLESS_WORKSPACE_ID: workspaceId,
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
      assert.deepEqual(await health.json(), {
        status: 'ok',
        service: 'macro-headless',
        workspace_id: workspaceId,
      });

      const unknownWorkspace = await fetch(
        `${baseUrl}/api/v1/workspaces/not-${workspaceId}/bootstrap`,
        { headers },
      );
      assert.equal(unknownWorkspace.status, 404, 'An unknown workspace id must fail closed.');
      assert.equal((await unknownWorkspace.json()).code, 'REMOTE_WORKSPACE_NOT_FOUND');

      const scopedBootstrap = await fetch(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/bootstrap`,
        { headers },
      );
      assert.equal(scopedBootstrap.status, 200, 'The effective workspace id must remain routable.');

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

      const projectRead = await fetch(`${baseUrl}/api/v1/tools/execute`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'Implement',
          tool_id: 'read',
          args: { path: 'marker.txt' },
          focused_project_id: 'project-smoke',
        }),
      });
      const projectReadBody = await projectRead.json();
      assert.equal(
        projectRead.status,
        200,
        `A project-scoped read must succeed without workspace_path: ${JSON.stringify(projectReadBody)}`,
      );
      assert.match(
        projectReadBody.result,
        /focused project marker/,
        'An omitted workspace_path must resolve to the declared project, not the workspace root.',
      );

      const largeCheckpoint = await fetch(`${baseUrl}/api/v1/tools/checkpoint-snapshot`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'Implement',
          path: 'large.txt',
          project_id: 'project-smoke',
        }),
      });
      assert.equal(
        largeCheckpoint.status,
        200,
        'A 1,228,800-byte checkpoint must fit the shared bounded response budget.',
      );
      assert.equal((await largeCheckpoint.json()).snapshot.content.length, 1_228_800);

      const addedProject = project('project-added', 'added', addedProjectRoot);
      await Promise.all([
        writeFile(path.join(addedProjectRoot, 'marker.txt'), 'fresh registry marker'),
        writeFile(
          workspaceStatePath,
          `${JSON.stringify(workspaceState([initialProject, addedProject], 2), null, 2)}\n`,
        ),
      ]);
      const refreshedRead = await fetch(`${baseUrl}/api/v1/tools/execute`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'Implement',
          tool_id: 'read',
          args: { path: 'marker.txt' },
          focused_project_id: 'project-added',
        }),
      });
      assert.equal(refreshedRead.status, 200, 'A project added after startup must become available.');
      assert.match((await refreshedRead.json()).result, /fresh registry marker/);

      const pendingRetry = await fetch(`${baseUrl}/api/v1/tools/execute`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(crashedMutation),
      });
      assert.equal(
        pendingRetry.status,
        409,
        'The exact mutation from an interrupted pending record must not be replayed.',
      );
      assert.equal((await pendingRetry.json()).code, 'REMOTE_MUTATION_PENDING');
      assert.equal(
        await Bun.file(path.join(addedProjectRoot, 'crash-probe.txt')).exists(),
        false,
        'A pending retry must not produce the mutation side effect.',
      );

      const readOnlyProject = project('project-smoke', 'smoke', projectRoot, true);
      await writeFile(
        workspaceStatePath,
        `${JSON.stringify(workspaceState([readOnlyProject, addedProject], 3), null, 2)}\n`,
      );
      const rejectedWrite = await fetch(`${baseUrl}/api/v1/tools/execute`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'Implement',
          tool_id: 'write',
          args: { path: 'must-not-exist.txt', content: 'blocked', expected_revision: 'absent' },
          execution_id: 'read-only-smoke-write',
          focused_project_id: 'project-smoke',
        }),
      });
      assert.equal(rejectedWrite.status, 403, 'A read-only change after startup must be enforced.');
      assert.equal(await Bun.file(path.join(projectRoot, 'must-not-exist.txt')).exists(), false);

      const pendingStatus = await fetch(
        `${baseUrl}/api/v1/tools/executions/${crashedExecutionId}`,
        { headers },
      );
      assert.deepEqual(await pendingStatus.json(), {
        state: 'pending',
        recovery: 'record_indeterminate_with_approval',
      });
      const agentResolution = await fetch(
        `${baseUrl}/api/v1/tools/executions/${crashedExecutionId}/resolve-indeterminate`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolution: 'record_indeterminate' }),
        },
      );
      assert.equal(agentResolution.status, 401, 'The agent bearer must not resolve crash ambiguity.');
      const approvedResolution = await fetch(
        `${baseUrl}/api/v1/tools/executions/${crashedExecutionId}/resolve-indeterminate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${approvalToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ resolution: 'record_indeterminate' }),
        },
      );
      assert.equal(approvedResolution.status, 200, 'Approval must close the pending record safely.');
      const resolution = await approvedResolution.json();
      assert.equal(resolution.state, 'completed');
      assert.equal(resolution.status_code, 409);
      assert.equal(resolution.body.code, 'REMOTE_MUTATION_OUTCOME_INDETERMINATE');

      const resolvedStatus = await fetch(
        `${baseUrl}/api/v1/tools/executions/${crashedExecutionId}`,
        { headers },
      );
      const resolved = await resolvedStatus.json();
      assert.equal(resolved.state, 'completed');
      assert.equal(resolved.body.resolution, 'record_indeterminate');

      const resolvedRetry = await fetch(`${baseUrl}/api/v1/tools/execute`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(crashedMutation),
      });
      assert.equal(
        resolvedRetry.status,
        409,
        'The same mutation must return its durable indeterminate result after resolution.',
      );
      assert.equal(
        (await resolvedRetry.json()).code,
        'REMOTE_MUTATION_OUTCOME_INDETERMINATE',
      );
      assert.equal(
        await Bun.file(path.join(addedProjectRoot, 'crash-probe.txt')).exists(),
        false,
        'Resolving an interrupted mutation must never replay its side effect.',
      );

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
