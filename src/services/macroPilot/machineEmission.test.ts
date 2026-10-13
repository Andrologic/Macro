import { expect, it } from 'bun:test';
import { ContentHost } from './contentHost';
import { ConversationCaptures } from './conversationCaptures';
import { createReviewCaptureService } from './reviewCapture';
import { MacroPilotNativeClient } from './nativeClient';
import { validateContentMessage, type ContentHostTelemetry, type ContentDelivery, type ContentRequest } from './contentProtocol';
import type { TextPolicy } from './conversationText';
const memory = () => { let value: string | null = null; return { load: async () => value, compareAndSwap: async (old: string | null, next: string) => { if (old !== value) return false; value = next; return true; } }; };
const epoch = Date.parse('2026-10-10T12:00:00.000Z');
async function harness(icon: { dataUrl: string; revision: string } | null = null) {
  const controller = new AbortController(); let clock = epoch; let policy: TextPolicy = { revision: 'visible-1', secrets: [] };
  const captures = new ConversationCaptures({ instanceId: 'instance', workspaceId: 'workspace', now: () => clock, storage: memory(), policy: () => policy,
    source: { projects: async () => [], tasks: async () => [], listConversations: async () => [], getConversation: async () => null,
      activity: () => ({ activity: 'idle', generatingMessageId: null }), listMessages: async () => [] } });
  const sample: Omit<ContentHostTelemetry, 'instance_id'> = { sample_id: 'sample', observed_at: new Date(epoch).toISOString(), expires_at: new Date(epoch + 5000).toISOString(),
    availability: 'available', reason: null, cpu_percent: 25, memory_used_bytes: 512, memory_total_bytes: 1024 };
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: controller.signal, now: () => clock,
    conversations: captures, machines: { telemetry: async () => sample, projectKey: () => 'context', icon: async () => icon },
    storage: memory(), reviews: createReviewCaptureService(), policy: async () => structuredClone(policy), commitReview: async () => false, reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); } });
  await host.initialize(); host.enableMachines(true);
  const request: ContentRequest<'instance.telemetry'> = { contract_version: '2.0', type: 'request', account_id: 'account', request_id: 'request', operation: 'instance.telemetry', body: { instance_id: 'instance' } };
  const delivery: ContentDelivery = { transport_version: '2.0', type: 'delivery', request_id: 'request', instance_id: 'instance', account_id: 'account', source_session_id: 'session',
    expires_at: new Date(epoch + 60000).toISOString(), capabilities: ['host-telemetry-1'], request };
  return { host, delivery, sample, controller, now: () => clock, advance: (ms: number) => clock += ms, changePolicy: () => policy = { revision: 'visible-2', secrets: ['synthetic-secret'] },
    authorize: async () => new Date(clock + 9000).toISOString() };
}
it('refuses a policy change during final handle authorization', async () => {
  const h = await harness(); let calls = 0;
  const result = await h.host.handle(h.delivery, async () => { if (++calls === 2) h.changePolicy(); return h.authorize(); });
  expect(calls).toBe(2); expect(result.response).toMatchObject({ type: 'error', code: 'snapshot_expired' });
  await h.host.dispose();
});
it('refuses a policy change during emission authorization', async () => {
  const h = await harness(); const result = await h.host.handle(h.delivery, h.authorize);
  await expect(h.host.validateMachineEmission(h.delivery, result, async () => { h.changePolicy(); return h.authorize(); })).rejects.toThrow('snapshot_expired');
  await expect(h.host.validateMachineEmission(h.delivery, result, h.authorize)).rejects.toThrow('snapshot_expired');
  await h.host.dispose();
});
it.each(['expiry', 'policy', 'revocation'] as const)('refuses %s changes during mocked credential reads before fetch', async mode => {
  const h = await harness(); let delay = false; const sent: string[] = [];
  const account = { contract_version: '1.0', type: 'account', account_id: 'account', identity: { provider: 'github', subject: '1', login: 'synthetic' }, revision: 1 };
  const session = { contract_version: '1.0', type: 'device_session', ref: { type: 'session', account_id: 'account', session_id: 'session' }, device_id: 'device', state: 'active', issued_at: new Date(epoch).toISOString(), expires_at: new Date(epoch + 86400000).toISOString(), revision: 1 };
  const values: Record<string, unknown> = { macro_pilot_native_v1: { configurationId: 'config', relayOrigin: 'https://relay.example', account, deviceSession: session,
    instance: { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: 'instance' }, label: 'Synthetic', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1 }, instanceCreationId: 'creation' } };
  const client = new MacroPilotNativeClient({ randomBytes: size => new Uint8Array(size).fill(1), sha256: async () => new Uint8Array(32), now: () => new Date(h.now()),
    getStateSnapshot: async () => ({ schemaVersion: 1, values }), setStateValue: async (key, value) => { values[key] = value; return { schemaVersion: 1, values }; },
    secretRead: async () => { if (delay) { delay = false; if (mode === 'expiry') h.advance(5001); else if (mode === 'policy') h.changePolicy(); else h.controller.abort(); } return 'd'.repeat(43); }, secretWrite: async () => {}, secretDelete: async () => {},
    fetch: async url => { if (String(url).endsWith('/me')) return new Response(JSON.stringify({ account, device_session: session }), { headers: { 'content-type': 'application/json' } });
      sent.push(String(url)); return new Response(null, { status: 204 }); } });
  await client.initialize(); const result = await h.host.handle(h.delivery, h.authorize);
  expect(validateContentMessage(result)).toBe(true);
  await h.host.validateMachineEmission(h.delivery, result, h.authorize);
  delay = true;
  await expect(client.requestContent('/pilot/v2/instances/instance/deliveries/request/result', result, new AbortController().signal, { beforeSend: () => h.host.validateMachineEmission(h.delivery, result, h.authorize) })).rejects.toThrow(mode === 'revocation' ? 'unavailable' : 'snapshot_expired');
  expect(sent).toHaveLength(0);
  await h.host.dispose();
});

it('refuses a forged icon hash in an otherwise valid application emission receipt', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('../../../contracts/macro-pilot/v2/fixtures/valid/project-icon-available.json', import.meta.url), 'utf8'));
  const icon = fixture.result.icon;
  const h = await harness({ dataUrl: `data:${icon.mime_type};base64,${icon.data_base64}`, revision: icon.sha256 });
  const request: ContentRequest<'project.icon'> = { contract_version: '2.0', type: 'request', request_id: 'icon-request', account_id: 'account', operation: 'project.icon',
    body: { ref: { instance_id: 'instance', workspace_id: 'workspace', project_id: 'project' } } };
  const delivery: ContentDelivery = { ...h.delivery, request_id: request.request_id, request, capabilities: ['project-icons-1'] };
  const result = await h.host.handle(delivery, h.authorize);
  expect(result.response.type).toBe('response');
  await h.host.validateMachineEmission(delivery, result, h.authorize);
  const response = result.response as { result: { icon: { sha256: string } } };
  response.result.icon.sha256 = '0'.repeat(64);
  expect(validateContentMessage(result)).toBe(true);
  await expect(h.host.validateMachineEmission(delivery, result, h.authorize)).rejects.toThrow('integrity_failed');
  await h.host.dispose();
});
