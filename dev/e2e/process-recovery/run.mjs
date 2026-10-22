#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { stopProcesses } from './processes.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = mkdtempSync(path.join(tmpdir(), 'macro-process-recovery-'));
const logRoot = process.env.MACRO_RECOVERY_LOG_DIR || temporary;
mkdirSync(logRoot, { recursive: true });
const helperSource = readFileSync(path.join(repository, 'src-tauri/src/process_recovery_transport.rs'));
const helperHash = createHash('sha256').update(helperSource).digest('hex');
const helper = path.join(temporary, 'native-transport');
const timeoutMs = 60_000;
const checkpoints = { file: 'file-effect-before-receipt', merge: 'first-merge-before-checkpoint',
  metadata: 'metadata-before-journal-close', response: 'failed-response-retained' };
const scenarios = ['file', 'merge', 'metadata', 'response'];
let daemon;
let daemonExit;
let daemonPort;
let daemonLog = '';

async function startGitDaemon() {
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  daemonPort = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  daemon = spawn('git', ['daemon', '--verbose', '--export-all', '--reuseaddr', '--listen=127.0.0.1',
    `--port=${daemonPort}`, `--base-path=${temporary}`, '--strict-paths',
    ...['merge', 'metadata'].flatMap(scenario => ['a.git', 'b.git'].map(repo => path.join(temporary, scenario, repo)))], {
    cwd: temporary, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  daemonExit = new Promise(resolve => daemon.once('exit', resolve));
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Git daemon not ready: ${daemonLog}`)), 5000);
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`Git daemon exited (${code}): ${daemonLog}`)));
      daemon.stderr.on('data', chunk => { daemonLog += chunk; if (daemonLog.includes('Ready to rumble')) resolve(); });
    });
  } finally { clearTimeout(timer); }
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000, env: {
    PATH: process.env.PATH, HOME: temporary, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function buildHelper() {
  const build = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked',
    '--lib', '--no-run', '--message-format=json', '-j1'], {
    cwd: repository, env: { ...process.env, TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } }) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const buildExit = new Promise((resolve, reject) => { build.once('error', reject); build.once('close', resolve); });
  let executable;
  for await (const line of createInterface({ input: build.stdout })) {
    const record = JSON.parse(line);
    if (record.reason === 'compiler-message' && record.message.rendered) process.stderr.write(record.message.rendered);
    if (record.reason === 'compiler-artifact' && record.target.name === 'macro_lib' && record.profile.test && record.executable) executable = record.executable;
  }
  const status = await buildExit;
  assert.equal(status, 0, 'Native recovery helper build failed');
  assert(executable, 'Cargo did not report the native test executable');
  copyFileSync(executable, helper);
  console.log(`Native helper copied privately, sha256=${createHash('sha256').update(readFileSync(helper)).digest('hex')}`);
}

function fixture(scenario) {
  const root = path.join(temporary, scenario);
  mkdirSync(root);
  for (const directory of ['home', 'config', 'data']) mkdirSync(path.join(root, directory));
  if (scenario === 'merge' || scenario === 'metadata') {
    for (const name of ['a', 'b']) {
      const repo = path.join(root, name);
      mkdirSync(repo);
      git(repo, 'init', '-b', 'develop');
      git(repo, 'config', 'user.name', 'Recovery fixture');
      git(repo, 'config', 'user.email', 'recovery@example.test');
      writeFileSync(path.join(repo, 'base.txt'), 'base\n');
      git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
      git(repo, 'branch', 'main');
      git(repo, 'clone', '--bare', '.', path.join(root, `${name}.git`));
      git(repo, 'remote', 'add', 'origin', `git://127.0.0.1:${daemonPort}/${scenario}/${name}.git`);
      git(repo, 'fetch', 'origin');
      git(repo, 'branch', '--set-upstream-to=origin/develop', 'develop');
      git(repo, 'checkout', '-b', 'plan/recovery');
      writeFileSync(path.join(repo, 'effect.txt'), `${name}\n`);
      git(repo, 'add', '.'); git(repo, 'commit', '-m', 'plan effect');
      git(repo, 'checkout', 'develop');
    }
  }
  return root;
}

function snapshot(root, scenario) {
  const db = new Database(path.join(root, 'macro.db'), { readonly: true });
  try {
    const settings = db.query("SELECT key, value_json FROM app_settings WHERE key LIKE 'pending%Plan%' OR key LIKE 'completedPlan%' ORDER BY key").all();
    if (scenario === 'file') return {
      file: readFileSync(path.join(root, 'effect.txt'), 'utf8'),
      invocations: db.query('SELECT status, receipt_id FROM tool_invocations').all(),
    };
    if (scenario === 'response') return {
      messages: db.query('SELECT id, content, hidden_context, generation_attempts_json FROM messages WHERE role = \'assistant\' ORDER BY id').all(),
      storage: JSON.parse(readFileSync(path.join(root, 'local-storage.json'), 'utf8')),
    };
    return { settings, repositories: ['a', 'b'].map(name => ({
      refs: git(path.join(root, name), 'show-ref', '--heads'),
      count: git(path.join(root, name), 'rev-list', '--count', 'develop'),
      status: git(path.join(root, name), 'status', '--porcelain'),
      worktrees: git(path.join(root, name), 'worktree', 'list', '--porcelain'),
    })) };
  } finally { db.close(); }
}

function assertBoundary(root, scenario) {
  const state = snapshot(root, scenario);
  if (scenario === 'file') {
    assert.equal(state.file, 'effect\n');
    assert.deepEqual(state.invocations, [{ status: 'pending', receipt_id: null }]);
  } else if (scenario === 'response') {
    const { messageId } = JSON.parse(readFileSync(path.join(root, 'fixture.json'), 'utf8'));
    assert.equal(state.messages.find(message => message.id === messageId)?.content, '');
    const responses = JSON.parse(state.storage.macro_chat_unsaved_assistant_responses_v1);
    assert.equal(responses[messageId].id, messageId);
    assert.equal(responses[messageId].content, 'Response retained across process death.');
    assert.equal(responses[messageId].persistence_state, 'failed');
  } else {
    const pending = JSON.parse(state.settings.find(setting => setting.key === 'pendingPlanLifecycles:v1').value_json);
    const saga = pending.find(entry => entry.operation === 'finalize');
    if (scenario === 'merge') {
      assert.equal(saga.phase, 'prepared');
      assert.equal(saga.finalizationRepositories[0].phase, 'plan_merge_pending');
      const first = saga.finalizationRepositories[0];
      assert.notEqual(git(first.repoPath, 'rev-parse', 'develop'), first.expectedBaseCommit);
      const second = saga.finalizationRepositories[1];
      assert.equal(git(second.repoPath, 'rev-parse', 'develop'), second.expectedBaseCommit);
    } else {
      assert.equal(saga.phase, 'metadata_written');
      // Read committed @macro trees, independently of frontend caches and files.
      for (const name of ['a', 'b']) {
        const repo = path.join(root, name);
        const files = git(repo, 'ls-tree', '-r', '--name-only', '@macro').split('\n');
        const planPath = files.find(file => file.endsWith('/recovery-plan/plan.json'));
        assert(planPath, 'Committed plan metadata missing');
        assert.equal(JSON.parse(git(repo, 'show', `@macro:${planPath}`)).status, 'completed');
      }
    }
  }
  return state;
}

async function runPhase(root, scenario, phase) {
  const env = {
    PATH: process.env.PATH, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    MACRO_CONFIG_DIR: path.join(root, 'config'), MACRO_RECOVERY_ROOT: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', RUST_LOG: 'error',
  };
  const native = spawn(helper, ['--ignored', '--exact', 'process_recovery_transport::native_transport', '--nocapture', '--test-threads=1'], {
    cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const worker = spawn(process.execPath, [path.join(repository, 'dev/e2e/process-recovery/worker.ts'), root, scenario, phase], {
    cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const processes = [native, worker];
  const groups = processes.map(child => child.pid).filter(Number.isInteger);
  let log = '';
  let finished = false;
  let reachedBoundary = false;
  let complete;
  let fail;
  const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const exits = processes.map(child => new Promise(resolve => {
    child.once('error', error => { fail(error); resolve({ code: null, signal: null }); });
    child.once('exit', (code, signal) => {
      log += `exit pid=${child.pid} code=${code} signal=${signal}\n`;
      if (!finished) fail(new Error(`${scenario}/${phase}: child ${child.pid} exited before checkpoint, code=${code}, signal=${signal}`));
      resolve({ code, signal });
    });
  }));
  const timer = setTimeout(() => fail(new Error(`${scenario}/${phase}: no explicit completion within ${timeoutMs} ms`)), timeoutMs);
  for (const child of processes) child.stderr.on('data', chunk => { log += chunk; });
  const nativeLines = createInterface({ input: native.stdout });
  const workerLines = createInterface({ input: worker.stdout });
  nativeLines.on('line', line => {
    log += `native ${line}\n`;
    const marker = line.indexOf('MACRO_RECOVERY:');
    if (marker < 0) return;
    try {
      const response = JSON.parse(line.slice(marker + 'MACRO_RECOVERY:'.length));
      if ('ready' in response) {
        assert.equal(response.ready, native.pid);
        assert.equal(response.sourceHash, helperHash, 'Native helper/source mismatch');
      } else worker.stdin.write(`${JSON.stringify(response)}\n`);
    } catch (error) { fail(error); }
  });
  workerLines.on('line', line => {
    log += `worker ${line}\n`;
    if (!line.startsWith('MACRO_WORKER:')) return;
    try {
      const request = JSON.parse(line.slice('MACRO_WORKER:'.length));
      if ('command' in request) native.stdin.write(`${JSON.stringify(request)}\n`);
      else if ('boundary' in request) {
        assert.equal(phase, 'crash');
        assert.equal(request.boundary, checkpoints[scenario]);
        complete(request.boundary);
      } else if ('complete' in request) {
        assert.notEqual(phase, 'crash');
        finished = true;
        complete(request.complete);
      }
    } catch (error) { fail(error); }
  });
  // Cleanup can close a pipe after its peer exits. The root error stays in completion.
  for (const child of processes) child.stdin.on('error', error => { if (!finished) fail(error); });
  try {
    const point = await completion;
    if (phase === 'crash') { reachedBoundary = true; assertBoundary(root, scenario); }
    console.log(`${scenario}/${phase}: ${point}`);
  } catch (error) {
    throw new Error(`${error.message}\n${log.slice(-24000)}`, { cause: error });
  } finally {
    finished = true;
    clearTimeout(timer);
    try {
      const stopped = await stopProcesses(groups, exits, root);
      log += `owned process groups ${JSON.stringify(stopped.groups)}; no live fixture process remains\n`;
      if (reachedBoundary) assert(stopped.statuses.every(status => status.signal === 'SIGKILL'), 'The crash must kill both real processes');
    } finally {
      nativeLines.close(); workerLines.close();
      writeFileSync(path.join(logRoot, `${scenario}-${phase}.log`), log);
    }
  }
}

try {
  assert.equal(process.platform, 'linux', 'This recovery profile requires Linux process ownership inspection');
  await buildHelper();
  await startGitDaemon();
  for (const scenario of scenarios) {
    const root = fixture(scenario);
    await runPhase(root, scenario, 'crash');
    const interrupted = assertBoundary(root, scenario);
    await runPhase(root, scenario, 'resume');
    const resumed = snapshot(root, scenario);
    if (scenario === 'file') assert.equal(resumed.file, interrupted.file);
    if (scenario === 'merge' || scenario === 'metadata') {
      assert.equal(resumed.repositories[0].count, interrupted.repositories[0].count, 'First merge replayed');
      assert(resumed.repositories.every(repo => repo.status === ''));
    }
    await runPhase(root, scenario, 'again');
    assert.deepEqual(snapshot(root, scenario), resumed, `${scenario}: second restart changed durable state`);
  }
  console.log('Four native process-recovery scenarios passed, including second restart and process cleanup.');
} finally {
  try {
    if (daemon?.pid) {
      const stopped = await stopProcesses([daemon.pid], [daemonExit], temporary);
      daemonLog += `stopped fixture groups ${JSON.stringify(stopped.groups)}\n`;
    }
  } finally {
    writeFileSync(path.join(logRoot, 'git-daemon.log'), daemonLog);
  }
  rmSync(temporary, { recursive: true, force: true });
}
