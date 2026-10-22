import { afterAll, expect, it, mock } from 'bun:test';
import type { HostTelemetryDto } from '../../types/generated/ipc';
import type { ContentDelivery, ContentDeliveryResult, ContentHostTelemetry, ContentRequest } from './contentProtocol';
import type { DesktopStorePorts } from './desktopStorePorts';
import { ContentHost } from './contentHost';
import { ConversationCaptures } from './conversationCaptures';
import { createReviewCaptureService } from './reviewCapture';

type NativeSample = Omit<HostTelemetryDto, 'reuseForMs'> & { reuseForMs?: number | null };
let nativeRead: () => Promise<NativeSample>;
const core = await import('@tauri-apps/api/core');
mock.module('@tauri-apps/api/core', () => ({ ...core, invoke: async (command: string) => {
  if (command !== 'host_telemetry_read') throw new Error(`Unexpected IPC: ${command}`);
  return nativeRead();
} }));
afterAll(() => mock.restore());
// Keep the real desktop adapter and IPC wrapper in this composition.
const { desktopMachineResources } = await import('./desktopMachineResources');
const epoch = Date.parse('2026-10-10T12:00:00.000Z');
const memory = () => {
  let value: string | null = null;
  return { load: async () => value, compareAndSwap: async (previous: string | null, next: string) => {
    if (previous !== value) return false;
    value = next; return true;
  } };
};
const payload = (result: ContentDeliveryResult): ContentHostTelemetry => {
  expect(result.response).toMatchObject({ type: 'response', operation: 'instance.telemetry' });
  return (result.response as { result: ContentHostTelemetry }).result;
};
async function harness() {
  let utc = epoch; let monotonic = 10000; let policyRevision = 1; let reads = 0;
  const controller = new AbortController();
  const policy = () => ({ revision: `visible-${policyRevision}`, secrets: [] });
  const captures = new ConversationCaptures({ instanceId: 'instance', workspaceId: 'workspace', now: () => utc,
    storage: memory(), policy, source: { projects: async () => [], tasks: async () => [], listConversations: async () => [],
      getConversation: async () => null, activity: () => ({ activity: 'idle', generatingMessageId: null }), listMessages: async () => [] } });
  const ports = { app: () => ({ standaloneProjects: [], projectGroups: [] }) } as unknown as DesktopStorePorts;
  const dto = (reuseForMs: number | null | undefined = 5000): NativeSample => ({ sampleId: `sample:${reads}`,
    observedAt: new Date(utc).toISOString(), expiresAt: new Date(utc + 5000).toISOString(), availability: 'available', reason: null,
    cpuPercent: 25, memoryUsedBytes: 512, memoryTotalBytes: 1024, reuseForMs });
  let read = async () => dto();
  nativeRead = async () => { reads++; return read(); };
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: controller.signal,
    now: () => utc, monotonicNow: () => monotonic, conversations: captures, machines: desktopMachineResources('instance', 'workspace', ports),
    storage: memory(), reviews: createReviewCaptureService(), policy: async () => policy(), commitReview: async () => false,
    reviewRefs: async () => [], resolveReview: async () => { throw new Error('not_found'); } });
  await host.initialize(); host.enableMachines(true);
  const delivery = (id: string, session = 'session'): ContentDelivery => {
    const request: ContentRequest<'instance.telemetry'> = { contract_version: '2.0', type: 'request', account_id: 'account',
      request_id: id, operation: 'instance.telemetry', body: { instance_id: 'instance' } };
    return { transport_version: '2.0', type: 'delivery', request_id: id, instance_id: 'instance', source_session_id: session,
      account_id: 'account', expires_at: new Date(epoch + 60000).toISOString(), capabilities: ['host-telemetry-1'], request };
  };
  const checks: string[] = [];
  const authorize = async (value: ContentDelivery) => { checks.push(value.request_id); return new Date(utc + 9000).toISOString(); };
  return { host, controller, dto, delivery, authorize, checks, reads: () => reads, read: (value: () => Promise<NativeSample>) => { read = value; },
    advance: (ms: number, utcMs = ms) => { monotonic += ms; utc += utcMs; }, changePolicy: () => { policyRevision++; } };
}

it('shares one completed native sample across two real serial deliveries with separate authorities and envelopes', async () => {
  const h = await harness(); expect(h.reads()).toBe(0);
  const firstDelivery = h.delivery('first', 'reader:first');
  const secondDelivery = h.delivery('second', 'reader:second');
  const first = await h.host.handle(firstDelivery, h.authorize);
  const expected = { ...payload(first) };
  payload(first).cpu_percent = 99;
  h.advance(100);
  const second = await h.host.handle(secondDelivery, h.authorize);
  expect(h.reads()).toBe(1);
  expect(payload(second)).toEqual(expected);
  expect(payload(second)).not.toBe(payload(first));
  expect(h.checks).toEqual(['first', 'first', 'second', 'second']);
  expect(JSON.stringify(second)).not.toContain('reuseForMs');
  await h.host.validateMachineEmission(firstDelivery, first, h.authorize);
  await h.host.validateMachineEmission(secondDelivery, second, h.authorize);
  expect(h.checks.slice(-2)).toEqual(['first', 'second']);
  await h.host.dispose(); expect(h.reads()).toBe(1);
});

it.each([undefined, null])('keeps sources without a native budget uncached: %s', async hint => {
  const h = await harness(); h.read(async () => ({ ...h.dto(), reuseForMs: hint }));
  payload(await h.host.handle(h.delivery('first'), h.authorize));
  payload(await h.host.handle(h.delivery('second'), h.authorize));
  expect(h.reads()).toBe(2); await h.host.dispose();
});

it.each([NaN, -1, 5001, 1.5])('refuses an invalid native budget without caching and reads a valid next sample: %s', async hint => {
  const h = await harness(); h.read(async () => ({ ...h.dto(), reuseForMs: hint }));
  expect((await h.host.handle(h.delivery('invalid'), h.authorize)).response).toMatchObject({ type: 'error', code: 'content_unavailable' });
  expect(h.reads()).toBe(1);
  h.read(async () => h.dto());
  payload(await h.host.handle(h.delivery('valid'), h.authorize));
  expect(h.reads()).toBe(2); await h.host.dispose();
});

it('honors an old sample native budget at its exact monotonic boundary even while UTC is still valid', async () => {
  const h = await harness();
  h.read(async () => ({ ...h.dto(1000), observedAt: new Date(epoch - 4000).toISOString(), expiresAt: new Date(epoch + 1000).toISOString() }));
  const delivery = h.delivery('first'); const first = await h.host.handle(delivery, h.authorize);
  h.advance(999, 100);
  expect(payload(await h.host.handle(h.delivery('before'), h.authorize)).sample_id).toBe(payload(first).sample_id);
  expect(h.reads()).toBe(1);
  h.advance(1, 0);
  await expect(h.host.validateMachineEmission(delivery, first, h.authorize)).rejects.toThrow('snapshot_expired');
  h.read(async () => h.dto());
  expect(payload(await h.host.handle(h.delivery('boundary'), h.authorize)).sample_id).not.toBe(payload(first).sample_id);
  expect(h.reads()).toBe(2); await h.host.dispose();
});

it('charges the IPC wait before receiving the native budget and never installs a late result', async () => {
  const h = await harness();
  h.read(async () => { const dto = h.dto(1000); h.advance(1000, 10); return dto; });
  expect((await h.host.handle(h.delivery('late'), h.authorize)).response).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  h.read(async () => h.dto()); payload(await h.host.handle(h.delivery('retry'), h.authorize));
  expect(h.reads()).toBe(2); await h.host.dispose();
});

it('rejects a zero native budget and drops a sample whose policy changes during the source wait', async () => {
  const h = await harness(); h.read(async () => h.dto(0));
  expect((await h.host.handle(h.delivery('zero'), h.authorize)).response).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  h.read(async () => { h.changePolicy(); return h.dto(); });
  expect((await h.host.handle(h.delivery('changed-policy'), h.authorize)).response).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  h.read(async () => h.dto()); payload(await h.host.handle(h.delivery('fresh'), h.authorize));
  expect(h.reads()).toBe(3); await h.host.dispose();
});

it('rejects expiry during final authorization and retains each response deadline after slot replacement', async () => {
  const h = await harness(); h.read(async () => h.dto(1000));
  let authorizations = 0;
  const late = await h.host.handle(h.delivery('late'), async delivery => {
    if (++authorizations === 2) h.advance(1000, 10);
    return h.authorize(delivery);
  });
  expect(late.response).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  h.read(async () => h.dto(1000));
  const oldDelivery = h.delivery('old'); const old = await h.host.handle(oldDelivery, h.authorize);
  h.advance(1000, 10); h.read(async () => h.dto());
  const replacement = payload(await h.host.handle(h.delivery('replacement'), h.authorize));
  // Replacing the public payload cannot replace the receipt's original lifetime.
  (old.response as { result: ContentHostTelemetry }).result = { ...replacement };
  await expect(h.host.validateMachineEmission(oldDelivery, old, h.authorize)).rejects.toThrow('snapshot_expired');
  const currentDelivery = h.delivery('current'); const current = await h.host.handle(currentDelivery, h.authorize);
  await expect(h.host.validateMachineEmission(currentDelivery, current, async delivery => {
    h.advance(5000, 10); return h.authorize(delivery);
  })).rejects.toThrow('snapshot_expired');
  await h.host.dispose();
});

it('never borrows authority from a cached first delivery', async () => {
  const h = await harness(); payload(await h.host.handle(h.delivery('first'), h.authorize));
  await expect(h.host.handle(h.delivery('forbidden', 'another-session'), async () => { throw new Error('forbidden'); })).rejects.toThrow();
  const incapable = h.delivery('incapable'); incapable.capabilities = [];
  await expect(h.host.handle(incapable, h.authorize)).rejects.toThrow();
  let checks = 0;
  await expect(h.host.handle(h.delivery('revoked'), async value => {
    if (++checks === 2) { h.controller.abort(); throw new Error('session_revoked'); }
    return h.authorize(value);
  })).rejects.toThrow();
  expect(h.reads()).toBe(1); await h.host.dispose();
});

it('clears completed samples after policy changes and machine disable, including an in-flight old generation', async () => {
  const h = await harness(); payload(await h.host.handle(h.delivery('first'), h.authorize));
  h.changePolicy(); payload(await h.host.handle(h.delivery('new-policy'), h.authorize));
  expect(h.reads()).toBe(2);
  h.host.enableMachines(false); h.host.enableMachines(true);
  let resolve!: (sample: NativeSample) => void;
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  h.read(() => { entered(); return new Promise(done => { resolve = done; }); });
  const pending = h.host.handle(h.delivery('pending'), h.authorize); await started;
  h.host.enableMachines(false); h.host.enableMachines(true); resolve(h.dto());
  expect((await pending).response).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  h.read(async () => h.dto()); payload(await h.host.handle(h.delivery('fresh'), h.authorize));
  expect(h.reads()).toBe(4); await h.host.dispose();
});

it.each(['abort', 'dispose'] as const)('retires an in-flight read on %s without new IPC or late emission', async mode => {
  const h = await harness(); let resolve!: (sample: NativeSample) => void;
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
  h.read(() => { entered(); return new Promise(done => { resolve = done; }); });
  const pending = h.host.handle(h.delivery('pending'), h.authorize); await started;
  const closing = mode === 'dispose' ? h.host.dispose() : (h.controller.abort(), Promise.resolve());
  resolve(h.dto()); await expect(pending).rejects.toThrow('unavailable'); await closing;
  await expect(h.host.handle(h.delivery('after'), h.authorize)).rejects.toThrow('unavailable');
  expect(h.reads()).toBe(1); await h.host.dispose();
});

it('preserves cached unavailable metrics, retries IPC rejection, and refuses malformed samples', async () => {
  const h = await harness();
  h.read(async () => ({ ...h.dto(), availability: 'unavailable', reason: 'measurement_failed', cpuPercent: null, memoryUsedBytes: null, memoryTotalBytes: null }));
  const first = payload(await h.host.handle(h.delivery('first'), h.authorize));
  expect(first).toMatchObject({ availability: 'unavailable', reason: 'measurement_failed', cpu_percent: null, memory_used_bytes: null, memory_total_bytes: null });
  expect(payload(await h.host.handle(h.delivery('second'), h.authorize))).toEqual(first); expect(h.reads()).toBe(1);
  h.host.enableMachines(false); h.host.enableMachines(true);
  h.read(async () => { throw new Error('ipc_failed'); });
  expect((await h.host.handle(h.delivery('failure'), h.authorize)).response.type).toBe('error');
  h.read(async () => ({ ...h.dto(), cpuPercent: 101 }));
  expect((await h.host.handle(h.delivery('malformed'), h.authorize)).response.type).toBe('error');
  h.read(async () => h.dto()); payload(await h.host.handle(h.delivery('retry'), h.authorize));
  expect(h.reads()).toBe(4); await h.host.dispose();
});

it.each(['utc', 'monotonic'] as const)('invalidates a completed sample when the observed %s clock rolls back', async clock => {
  const h = await harness(); h.advance(100, 100);
  const firstDelivery = h.delivery('first'); const first = await h.host.handle(firstDelivery, h.authorize);
  h.advance(100, 100); payload(await h.host.handle(h.delivery('second'), h.authorize));
  h.advance(clock === 'monotonic' ? -1 : 1, clock === 'utc' ? -1 : 1);
  await expect(h.host.validateMachineEmission(firstDelivery, first, h.authorize)).rejects.toThrow('snapshot_expired');
  payload(await h.host.handle(h.delivery('after-rollback'), h.authorize));
  expect(h.reads()).toBe(2); await h.host.dispose();
});
