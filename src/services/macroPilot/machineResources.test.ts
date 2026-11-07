import { expect, it } from 'bun:test';
import { MachineResources, ICON_LIMIT, type MachineResourceSource } from './machineResources';
import { ContentHost } from './contentHost';
import { ConversationCaptures } from './conversationCaptures';
import { createReviewCaptureService } from './reviewCapture';
import { validateContentResponse, validateContentMessage, type ContentRequest, type ContentDelivery, type ContentProjectRef } from './contentProtocol';
import { taskActionPermissions, assertTaskActionPermissions } from './taskActionAuthorization';

const now = Date.parse('2026-10-10T12:00:00.000Z');
const ref: ContentProjectRef = { instance_id: 'instance', workspace_id: 'workspace', project_id: 'project' };
// Public 1x1 PNG fixture, no filesystem or real machine data.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
async function candidate(base64 = png, mime = 'image/png') {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  return { dataUrl: `data:${mime};base64,${base64}`, revision: hash };
}
const telemetry = () => ({ sample_id: 'sample', observed_at: new Date(now).toISOString(), expires_at: new Date(now + 5000).toISOString(), availability: 'available' as const, reason: null, cpu_percent: 30, memory_used_bytes: 512, memory_total_bytes: 2048 });
function source(): MachineResourceSource { return { telemetry: async () => telemetry(), projectKey: () => 'context', icon: async () => candidate() }; }
const memory = () => { let value: string | null = null; return { load: async () => value, compareAndSwap: async (old: string | null, next: string) => { if (old !== value) return false; value = next; return true; } }; };
it('bounds encoded resources, validates signature/hash and binds opaque IDs to the full project reference', async () => {
  const deps = source(); const resources = new MachineResources(deps, () => now);
  const first = await resources.icon(ref, 'context');
  expect(first.availability).toBe('available');
  expect(first.icon?.data_base64).toBe(png);
  expect(JSON.stringify(first)).not.toContain('sourcePath');
  expect(first.icon?.resource_id).not.toBe((await resources.icon({ ...ref, project_id: 'other' }, 'context')).icon?.resource_id);
  for (const invalid of [await candidate(btoa('<svg/>'), 'image/svg+xml'), await candidate(png, 'image/jpeg'), { ...await candidate(), revision: 'f'.repeat(64) }, await candidate(btoa('x'.repeat(ICON_LIMIT.rawBytes + 1))), { dataUrl: 'https://example.invalid/icon.png', revision: 'f'.repeat(64) }]) {
    deps.icon = async () => invalid;
    expect((await resources.icon(ref, 'context')).availability).toBe('unavailable');
  }
});
it('invalidates changed files, contexts, missing projects and expiry without exporting paths', async () => {
  let clock = now; let context: string | null = 'context'; const deps = source(); deps.projectKey = () => context;
  const resources = new MachineResources(deps, () => clock);
  const first = await resources.icon(ref, resources.context(ref));
  const replacement = btoa(atob(png) + '\0'); deps.icon = async () => candidate(replacement);
  expect((await resources.icon(ref, 'context')).icon?.resource_id).not.toBe(first.icon?.resource_id);
  context = 'changed'; expect(() => resources.validate(ref, 'context')).toThrow('snapshot_expired');
  context = null; expect(() => resources.context(ref)).toThrow('not_found');
  context = 'context'; clock += 300001;
  expect((await resources.icon(ref, 'context')).observed_at).toBe(new Date(clock).toISOString());
});
async function harness() {
  let clock = now; let reads = 0; let key: string | null = 'context';
  const deps = source(); const native = deps.icon;
  deps.icon = async id => { reads++; return native(id); }; deps.projectKey = () => key;
  const captures = new ConversationCaptures({ instanceId: 'instance', workspaceId: 'workspace', now: () => clock, storage: memory(), policy: () => ({ revision: 'visible-1', secrets: [] }), source: {
    projects: async () => [], tasks: async () => [], listConversations: async () => [], getConversation: async () => null, activity: () => ({ activity: 'idle', generatingMessageId: null }), listMessages: async () => [],
  } });
  const controller = new AbortController();
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: controller.signal, now: () => clock, conversations: captures, machines: deps, storage: memory(), reviews: createReviewCaptureService(), policy: async () => ({ revision: 'visible-1', secrets: [] }), commitReview: async () => false, reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); } });
  await host.initialize(); host.enableMachines(true);
  const req = (operation: 'project.icon' | 'instance.telemetry', id = 'request'): ContentRequest => operation === 'project.icon' ? { contract_version: '2.0', type: 'request', account_id: 'account', request_id: id, operation, body: { ref } } : { contract_version: '2.0', type: 'request', account_id: 'account', request_id: id, operation, body: { instance_id: 'instance' } };
  const delivery = (request: ContentRequest, caps: ContentDelivery['capabilities'] = ['host-telemetry-1', 'project-icons-1']): ContentDelivery => ({ transport_version: '2.0', type: 'delivery', request_id: request.request_id, instance_id: 'instance', source_session_id: 'session', account_id: 'account', expires_at: new Date(now + 60000).toISOString(), request, capabilities: caps });
  return { host, req, delivery, controller, reads: () => reads, change: (next: string | null) => { key = next; }, advance: (ms: number) => { clock += ms; }, authorize: async () => new Date(clock + 9000).toISOString() };
}
it('rejects unattested operations and requires supervise authorization', async () => {
  const h = await harness(); const req = h.req('project.icon');
  expect(validateContentMessage(h.delivery(req, []))).toBe(false);
  await expect(h.host.handle(h.delivery(req, []), h.authorize)).rejects.toThrow();
  await expect(h.host.handle(h.delivery(req), async () => { throw Error('forbidden'); })).rejects.toThrow();
  expect(h.reads()).toBe(0);
  expect(taskActionPermissions(req)).toEqual(['supervise']);
  expect(() => assertTaskActionPermissions(['supervise'], { granted_permissions: ['respond'] })).toThrow('forbidden');
  await h.host.dispose();
});
it('rechecks authorization and context after reads, including cached icon consultation', async () => {
  const h = await harness(); const req = h.req('project.icon'); let calls = 0;
  const first = await h.host.handle(h.delivery(req), async () => { calls++; return h.authorize(); });
  expect(first.response.type).toBe('response'); expect(calls).toBe(2); expect(validateContentResponse(req, first.response)).toBe(true);
  calls = 0;
  const changed = await h.host.handle(h.delivery(h.req('project.icon', 'second')), async () => { if (++calls === 2) h.change('moved'); return h.authorize(); });
  expect(changed.response.type).toBe('error');
  if (changed.response.type === 'error') expect(changed.response.code).toBe('snapshot_expired');
  calls = 0;
  await expect(h.host.handle(h.delivery(h.req('project.icon', 'revoked')), async () => { if (++calls === 2) { h.controller.abort(); throw Error('session_revoked'); } return h.authorize(); })).rejects.toThrow();
  await h.host.dispose();
});
it('never emits expired CPU samples and preserves unavailable as null', async () => {
  const h = await harness(); const req = h.req('instance.telemetry');
  h.advance(5000);
  const result = await h.host.handle(h.delivery(req), h.authorize);
  expect(result.response.type).toBe('error');
  if (result.response.type === 'error') expect(result.response.code).toBe('snapshot_expired');
  const resources = new MachineResources({ ...source(), telemetry: async () => ({ ...telemetry(), availability: 'unavailable', reason: 'measurement_failed', cpu_percent: null, memory_used_bytes: null, memory_total_bytes: null }) }, () => now);
  const sample = await resources.telemetry('instance');
  expect(validateContentResponse(req, { contract_version: '2.0', type: 'response', account_id: 'account', request_id: req.request_id, operation: 'instance.telemetry', result: sample })).toBe(true);
  await h.host.dispose();
});
it('refuses stale resources before transport retries after context changes or sample expiry', async () => {
  const h = await harness();
  const req = h.req('project.icon'); const delivery = h.delivery(req);
  const result = await h.host.handle(delivery, h.authorize);
  await h.host.validateMachineEmission(delivery, result, h.authorize);
  h.change('moved');
  await expect(h.host.validateMachineEmission(delivery, result, h.authorize)).rejects.toThrow('snapshot_expired');
  const cpu = h.req('instance.telemetry', 'cpu'); const cpuDelivery = h.delivery(cpu);
  const sample = await h.host.handle(cpuDelivery, h.authorize);
  h.advance(5000);
  await expect(h.host.validateMachineEmission(cpuDelivery, sample, h.authorize)).rejects.toThrow('snapshot_expired');
  await h.host.dispose();
});
it('retains alternating project resources and invalidates only the changed project context', async () => {
  const keys = new Map([['project', 'context:first'], ['second', 'context:second']]);
  const deps = source(); deps.projectKey = target => keys.get(target.project_id) ?? null;
  const resources = new MachineResources(deps, () => now);
  const secondRef = { ...ref, project_id: 'second' };
  const first = await resources.icon(ref, resources.context(ref));
  const second = await resources.icon(secondRef, resources.context(secondRef));
  expect((await resources.icon(ref, resources.context(ref))).icon).toBe(first.icon);
  expect((await resources.icon(secondRef, resources.context(secondRef))).icon).toBe(second.icon);
  keys.set(ref.project_id, 'context:first-moved');
  expect(() => resources.validate(ref, 'context:first')).toThrow('snapshot_expired');
  expect((await resources.icon(secondRef, resources.context(secondRef))).icon).toBe(second.icon);
  expect((await resources.icon(ref, resources.context(ref))).icon).not.toBe(first.icon);
  keys.delete(ref.project_id);
  expect(() => resources.context(ref)).toThrow('not_found');
  expect((await resources.icon(secondRef, resources.context(secondRef))).icon).toBe(second.icon);
  resources.clear();
  expect((await resources.icon(secondRef, resources.context(secondRef))).icon).not.toBe(second.icon);
});
