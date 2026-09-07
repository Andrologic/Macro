/** Opt-in integration check against an independently launched loopback relay fixture.
 * Uses only public HTTP contracts. No imports from the relay repository.
 * bun dev/pilot-relay-cross-check.ts http://127.0.0.1:PORT
 */
import assert from 'node:assert/strict';
import { MacroPilotNativeClient, type PilotClientDependencies } from '../src/services/macroPilot/nativeClient';
import { PilotRuntime } from '../src/services/macroPilot/runtime';
import { PilotKernel, type KernelStorage } from '../src/services/macroPilot/kernel';
import { object, type Resource, type Wire } from '../src/services/macroPilot/protocol';
import taskFixture from '../contracts/macro-pilot/v1/fixtures/valid/task.json';
import replyFixture from '../contracts/macro-pilot/v1/fixtures/valid/task-reply-command.json';

const loopback = new URL(process.argv[2] || '');
assert.equal(loopback.protocol, 'http:');
assert.equal(loopback.hostname, '127.0.0.1');
assert.ok(loopback.port && loopback.pathname === '/' && !loopback.search && !loopback.hash && !loopback.username && !loopback.password);
const configuredOrigin = 'https://pilot-fixture.invalid';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const id = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
function device() {
  const values: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const key = (scope: unknown) => JSON.stringify(scope);
  const dependencies: PilotClientDependencies = {
    fetch: async (input, options) => {
      const requested = new URL(String(input));
      assert.equal(requested.origin, configuredOrigin);
      const response = await fetch(`${loopback.origin}${requested.pathname}`, {
        ...options,
        redirect: 'error',
        signal: options?.signal ?? AbortSignal.timeout(30_000),
      });
      // Test-only origin mapping. Production still requires HTTPS and refuses redirects.
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
    getStateSnapshot: async () => ({ schemaVersion: 1, values }),
    setStateValue: async (name, value) => { values[name] = structuredClone(value); return { schemaVersion: 1, values }; },
    secretRead: async scope => secrets.get(key(scope)) ?? null,
    secretWrite: async (scope, value) => { secrets.set(key(scope), value); },
    secretDelete: async scope => { secrets.delete(key(scope)); },
    randomBytes: size => crypto.getRandomValues(new Uint8Array(size)),
    sha256: async value => new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource)),
    now: () => new Date(),
  };
  return { dependencies, client: new MacroPilotNativeClient(dependencies) };
}
async function login(client: MacroPilotNativeClient, label: string) {
  await client.initialize();
  const attempt = await client.connect(configuredOrigin, label);
  assert.equal(typeof attempt.attemptId, 'string');
  assert.ok(attempt.attemptId.length > 0);
  assert.equal(attempt.verificationUri, 'https://github.com/login/device');
  await delay(attempt.interval * 1000 + 50);
  const account = await client.pollAuth();
  assert.ok(account);
  assert.equal(client.getState().status, 'confirming_account');
  await client.confirmAccount(account.account_id);
  assert.equal(client.getState().status, 'connected');
}
const desktop = device();
const companion = device(); // A second real native client, acting as the consumer of exchanges.
let runtime: PilotRuntime | undefined;
let reconnected: MacroPilotNativeClient | undefined;
try {
  await Promise.all([login(desktop.client, 'Cross-check desktop'), login(companion.client, 'Cross-check consumer')]);
  console.log('PASS native Device Flow, explicit confirmation and distinct sessions');
  assert.notEqual(desktop.client.getState().deviceSession?.ref.session_id, companion.client.getState().deviceSession?.ref.session_id);
  const instance = await desktop.client.createOrAttachInstance({ label: 'Isolated cross-check' });
  const instanceId = instance.ref.instance_id;
  const route = `/instances/${encodeURIComponent(instanceId)}`;
  const request = await companion.client.request('POST', `${route}/access-requests`, { transport_version: '1.0' }, { authenticated: true });
  const requests = await desktop.client.listAccessRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].access_request_id, object(request.data).access_request_id);
  await desktop.client.resolveAccess(requests[0].access_request_id, 'grant', ['supervise', 'respond']);
  console.log('PASS instance creation and explicit association permissions');

  let journal: string | null = null;
  let effects = 0;
  let task = { ...structuredClone(taskFixture), ref: { ...taskFixture.ref, instance_id: instanceId }, revision: 7, state: 'waiting_reply', reply_context: { conversation_id: 'conversation:cross-check' } } as Resource;
  let taskDeleted = false;
  let otherTask = { ...structuredClone(task), ref: { ...task.ref, workspace_id: 'workspace:other', task_id: 'task:other-01' } } as Resource;
  const storage: KernelStorage = { load: async () => journal, compareAndSwap: async (previous, next) => {
    if (journal !== previous) return false;
    journal = next; return true;
  } };
  const makeRuntime = (client: MacroPilotNativeClient) => new PilotRuntime(client, dependencies => new PilotKernel({
    ...dependencies, storage,
    project: () => ({ snapshots: [...(taskDeleted ? [] : [structuredClone(task)]), structuredClone(otherTask)], state: null }),
    execute: async (_command, guard) => {
      await guard.authorizeBeforeEffect(); guard.assertCurrent();
      effects++;
      task = { ...task, revision: task.revision + 1, state: 'running' };
      delete task.reply_context;
    },
  }));
  runtime = makeRuntime(desktop.client);
  await runtime.start();
  async function exchange(message: Wire): Promise<Wire> {
    const exchangeId = id('exchange');
    let queued = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await companion.client.request('POST', `${route}/exchanges`, { transport_version: '1.0', type: 'exchange', exchange_id: exchangeId, message }, { authenticated: true });
        queued = true; break;
      } catch (error) {
        if (object(error).code !== 'unavailable') throw error;
        await delay(100);
      }
    }
    assert.ok(queued, 'Producer must become reachable');
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await companion.client.request('GET', `${route}/exchanges/${encodeURIComponent(exchangeId)}`, undefined, { authenticated: true });
      if (result.status === 200) return object(result.data);
      await delay(50);
    }
    throw Error('Timed out waiting for canonical delivery result');
  }
  const page = await exchange({ contract_version: '1.0', type: 'page_request', item_type: 'task', scope: { type: 'instance', instance_id: instanceId }, limit: 1 });
  const workspaceScope = { type: 'workspace', instance_id: instanceId, workspace_id: task.ref.workspace_id };
  const workspacePage = await exchange({ contract_version: '1.0', type: 'page_request', item_type: 'task', scope: workspaceScope, limit: 10 });
  assert.equal(object(workspacePage.message).type, 'page');
  assert.notEqual(object(workspacePage.resume_point).stream_id, object(page.resume_point).stream_id);
  assert.equal(object(page.message).type, 'page');
  assert.equal((object(page.message).items as unknown[]).length, 1);
  const session = companion.client.getState().deviceSession!;
  const command = { ...structuredClone(replyFixture), command_id: id('command'), idempotency_key: id('intent'), target: task.ref, expected_revision: 7,
    issued_by: { account_id: session.ref.account_id, session_id: session.ref.session_id, device_id: session.device_id },
    payload: { conversation_id: 'conversation:cross-check', answer: 'Continue the fixture task.' } };
  const first = await exchange(command);
  assert.equal(object(first.message).outcome, 'accepted');
  const duplicate = await exchange(command);
  assert.deepEqual(duplicate.message, first.message);
  assert.equal(effects, 1);
  otherTask = { ...otherTask, revision: otherTask.revision + 1, title: 'Changed outside the first workspace' };
  const resumed = await exchange({ contract_version: '1.0', type: 'resume_request', ...object(page.resume_point), limit: 10 });
  assert.equal(object(resumed.message).type, 'event_batch');
  assert.equal((object(resumed.message).events as unknown[]).length, 2);
  const workspaceResumed = await exchange({ contract_version: '1.0', type: 'resume_request', ...object(workspacePage.resume_point), limit: 10 });
  assert.equal(object(workspaceResumed.message).type, 'event_batch');
  assert.equal((object(workspaceResumed.message).events as unknown[]).length, 1);
  console.log('PASS independent scope streams and contiguous filtered events');
  taskDeleted = true;
  const removed = await exchange({ contract_version: '1.0', type: 'resume_request', ...object(workspacePage.resume_point), limit: 10 });
  assert.equal(object(object(removed.message).error).code, 'cursor_expired');
  const stalePage = await exchange({ contract_version: '1.0', type: 'page_request', item_type: 'task', scope: { type: 'instance', instance_id: instanceId }, limit: 1, cursor: object(page.message).next_cursor });
  assert.equal(object(object(stalePage.message).error).code, 'cursor_expired');
  const freshPage = await exchange({ contract_version: '1.0', type: 'page_request', item_type: 'task', scope: workspaceScope, limit: 10 });
  assert.equal((object(freshPage.message).items as unknown[]).length, 0);
  console.log('PASS deletion expires old streams/pages and clean bootstrap removes the task');
  console.log('PASS real HTTP page, command, authorization, result, idempotent replay and event resume');

  await runtime.stop();
  reconnected = new MacroPilotNativeClient(desktop.dependencies);
  await reconnected.initialize();
  assert.equal(reconnected.getState().status, 'connected');
  assert.equal((await reconnected.createOrAttachInstance()).ref.instance_id, instanceId);
  runtime = makeRuntime(reconnected);
  await runtime.start();
  const afterRestart = await exchange(command);
  assert.deepEqual(afterRestart.message, first.message);
  assert.equal(effects, 1);
  console.log('PASS reconnect, same instance and durable journal replay without a second effect');
  await runtime.stop();
  await assert.rejects(() => companion.client.request('POST', `${route}/exchanges`, { transport_version: '1.0', type: 'exchange', exchange_id: id('exchange'), message: command }, { authenticated: true }));
  console.log('PASS explicit disconnect removes producer reachability');
  console.log('LIMIT canonical desktop task/provider and OS vault are injected; HTTP server and native client/kernel/runtime are real. No OAuth or external network.');
} finally {
  await runtime?.stop();
  await Promise.allSettled([desktop.client.logout(), companion.client.logout(), reconnected?.logout()]);
}
