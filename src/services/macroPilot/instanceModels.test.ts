import { expect, test } from 'bun:test';
import { desktopTransferModels } from './desktopConversationInteractions';
import type { DesktopStorePorts } from './desktopStorePorts';
import { ContentHost } from './contentHost';
import { ConversationCaptures } from './conversationCaptures';
import { createReviewCaptureService } from './reviewCapture';
import { validateContentMessage, validateContentResponse, type ContentDelivery, type ContentInstanceModels } from './contentProtocol';
const memory = () => { let value: string | null = null; return { load: async () => value, compareAndSwap: async (old: string | null, next: string) => { if (old !== value) return false; value = next; return true; } }; };
const policy = { revision: 'visible-1', secrets: ['synthetic-secret'] };
const model = { provider_id: 'macro-ai', provider_name: 'Macro AI', model_id: 'model', model_name: 'Model', reasoning_efforts: [] };
const epoch = Date.parse('2026-01-01T00:00:00Z');
function ports(count = 1) {
  const provider = { id: 'macro-ai', name: 'Macro AI', providerType: 'openai', isEnabled: true, hasStoredApiKey: true };
  const providers = { providerConfigs: [provider, { ...provider, id: 'disabled', providerType: 'chatgpt', isEnabled: false }, { ...provider, id: 'unlinked', providerType: 'chatgpt', hasStoredApiKey: false }],
    modelsByProvider: { 'macro-ai': Array.from({ length: count }, (_, i) => ({ id: `model-${i}`, name: 'Model', isEnabled: true })) },
    getAvailableReasoningEfforts: () => [], loadProviderModels: () => { throw Error('must not refresh'); } };
  return { providers, ports: { providers: () => providers } as unknown as DesktopStorePorts };
}
test('target catalog reads cached supported enabled models without exposing credentials or refreshing', () => {
  const f = ports();
  expect(desktopTransferModels(f.ports, policy)).toEqual([{ ...model, model_id: 'model-0' }]);
  f.providers.modelsByProvider['macro-ai'][0].isEnabled = false;
  expect(desktopTransferModels(f.ports, policy)).toEqual([]);
  f.providers.modelsByProvider['macro-ai'][0].isEnabled = true;
  f.providers.modelsByProvider['macro-ai'][0].name = 'synthetic-secret';
  expect(desktopTransferModels(f.ports, policy)).toEqual([]);
  expect(() => desktopTransferModels(ports(1001).ports, policy)).toThrow('resource_limit');
});
async function harness() {
  let models = [model], clock = epoch;
  const captures = new ConversationCaptures({ instanceId: 'instance', workspaceId: 'workspace', storage: memory(), policy: () => policy,
    source: { projects: async () => [], tasks: async () => [], listConversations: async () => [], getConversation: async () => null,
      activity: () => ({ activity: 'idle', generatingMessageId: null }), listMessages: async () => [] } });
  const host = new ContentHost({ accountId: 'account', instanceId: 'instance', signal: new AbortController().signal, now: () => clock,
    conversations: captures, models: () => models, storage: memory(), reviews: createReviewCaptureService(), policy: async () => policy,
    commitReview: async () => false, reviewRefs: async () => [], resolveReview: async () => { throw Error('not_found'); } });
  await host.initialize();
  const request = { contract_version: '2.0' as const, type: 'request' as const, account_id: 'account', request_id: 'request', operation: 'instance.models' as const, body: { instance_id: 'instance' } };
  const delivery: ContentDelivery = { transport_version: '2.0', type: 'delivery', request_id: request.request_id, instance_id: 'instance', account_id: 'account', source_session_id: 'session',
    expires_at: new Date(epoch + 60000).toISOString(), capabilities: ['instance-models-1'], request };
  return { host, request, delivery, authorize: async () => new Date(clock + 9000).toISOString(), change: () => { models = []; }, expire: () => { clock += 30000; } };
}
test('instance model result is correlated, bounded, duplicate-free and capability-attested', async () => {
  const h = await harness();
  const result = await h.host.handle(h.delivery, h.authorize);
  expect(result.response.type).toBe('response');
  expect(validateContentResponse(h.request, result.response)).toBe(true);
  expect(validateContentMessage({ ...h.delivery, capabilities: [] })).toBe(false);
  const response = structuredClone(result.response) as { result: ContentInstanceModels };
  response.result.instance_id = 'other'; expect(validateContentResponse(h.request, response)).toBe(false);
  response.result.instance_id = 'instance'; response.result.models.push(model); expect(validateContentResponse(h.request, response)).toBe(false);
  response.result.models = Array.from({ length: 1001 }, (_, i) => ({ ...model, model_id: `m-${i}` })); expect(validateContentMessage(response)).toBe(false);
  response.result.models = [model]; response.result.expires_at = new Date(epoch + 30001).toISOString(); expect(validateContentMessage(response)).toBe(false);
  await h.host.dispose();
});
test('catalog emission and retries fail closed after cached configuration changes or expiry', async () => {
  for (const change of ['models', 'expiry']) {
    const h = await harness(), result = await h.host.handle(h.delivery, h.authorize);
    await h.host.validateConversationEmission(h.delivery, result);
    if (change === 'models') h.change(); else h.expire();
    await expect(h.host.validateConversationEmission(h.delivery, result)).rejects.toThrow('stale_revision');
    const retry = await h.host.handle(h.delivery, h.authorize);
    expect(retry.response).toMatchObject({ type: 'response', result: { models: change === 'models' ? [] : [model] } });
    await h.host.dispose();
  }
});
test('catalog never escapes a rejected current authorization', async () => {
  const h = await harness();
  await expect(h.host.handle(h.delivery, async () => { throw Error('revoked'); })).rejects.toThrow('revoked');
  await h.host.dispose();
});
