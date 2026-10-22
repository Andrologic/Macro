import { expect, it, spyOn } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UseChatStoreScenarioContext } from '../useChatStore.test';
import { buildMessageState } from '../chat/chatMessageState';
import * as compaction from '../../services/contextCompaction';
import { PortableWorkBudget } from '../../services/ai/portableHistoryInspection';
import { PortableHistoryArchive } from '../../services/ai/portableHistoryArchive';
import { readNativeTargetSpool, makeNormalizationSeed, writeNormalizationSeed, PORTABLE_FACTS, OMITTED_FACT, SOURCE_SUMMARY, TARGET_SUMMARY, PNG } from '../../test-utils/portableNormalizationRecipe';
import { policy } from '../../services/ai/portableHistoryFixtures.testSupport';
import type { ChatMessage } from '../../types';
import type { StreamMessage } from '../../services/streamingChat';

export function registerPortableNormalizationScenarios(c: UseChatStoreScenarioContext) {
  const root = process.env.MACRO_PORTABLE_NORMALIZATION_DIR;
  it.skipIf(!root)('portable normalization real source checkpoint and target-only four adapters', async () => {
    const phase = process.env.MACRO_PORTABLE_NORMALIZATION_PHASE;
    if (!['seed', 'prepare'].includes(phase ?? '')) throw new Error('explicit normalization phase required');
    const requests: unknown[] = [], measures: unknown[] = [];
    const requestBudget = new PortableWorkBudget(16 * 1024 * 1024); // Test artifacts retained across projection scopes.
    const requestReleases: (() => void)[] = [];
    const stream = c.streamChatMock.getMockImplementation()!, nonstream = c.sendChatNonStreamingMock.getMockImplementation()!, fetch = globalThis.fetch;
    const originalBuild = compaction.buildCompactedMessagesForRequest;
    const stringify = JSON.stringify, parse = JSON.parse;
    const jsonCosts = { stringifyCalls: 0, stringifyOutputBytes: 0, maxStringifyOutputBytes: 0, parseCalls: 0, parseInputBytes: 0, maxParseInputBytes: 0 };
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      const result = stringify(...args), bytes = typeof result === 'string' ? Buffer.byteLength(result) : 0;
      jsonCosts.stringifyCalls++; jsonCosts.stringifyOutputBytes += bytes; jsonCosts.maxStringifyOutputBytes = Math.max(jsonCosts.maxStringifyOutputBytes, bytes); return result;
    }) as typeof JSON.stringify;
    JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
      const bytes = typeof args[0] === 'string' ? Buffer.byteLength(args[0]) : 0;
      jsonCosts.parseCalls++; jsonCosts.parseInputBytes += bytes; jsonCosts.maxParseInputBytes = Math.max(jsonCosts.maxParseInputBytes, bytes); return parse(...args);
    }) as typeof JSON.parse;
    let networkCalls = 0, streamSentinels = 0, nonstreamSentinels = 0, summaryCalls = 0, validatedSource = 0, reusedSource = 0;
    const blockedFetch = () => { networkCalls++; throw new Error('network_forbidden'); };
    globalThis.fetch = Object.assign(blockedFetch, { preconnect: blockedFetch });
    c.streamChatMock.mockImplementation(async () => { streamSentinels++; throw new Error('provider_stream_forbidden'); });
    c.sendChatNonStreamingMock.mockImplementation(async () => { nonstreamSentinels++; throw new Error('provider_nonstream_forbidden'); });
    const builder = spyOn(compaction, 'buildCompactedMessagesForRequest').mockImplementation(async params => {
      const source = !params.orderedMessages.some(message => message.portable_history);
      if (source && params.currentCompactionState) {
        expect(compaction.validateCompactionState(params.currentCompactionState, params.orderedMessages, params)).toBe(true); validatedSource++;
      }
      const result = await originalBuild({ ...params, generateSummary: async input => {
        summaryCalls++;
        // Test-only controlled generation. Facts are copied exclusively from
        // the actual compactable target/source values, never injected as data.
        const lines = input.compactableMessages.flatMap(message => message.content.split('\n')).filter(line => PORTABLE_FACTS.some(fact => line.includes(fact)) && !line.includes(OMITTED_FACT));
        return JSON.stringify({ currentObjective: source ? SOURCE_SUMMARY : TARGET_SUMMARY, userInstructions: [], decisions: [], openQuestions: [], activeFiles: [], toolFacts: lines, remainingWork: [], summary: source ? SOURCE_SUMMARY : TARGET_SUMMARY });
      } });
      if (source && params.currentCompactionState) { expect(result.usedExistingCompaction).toBe(true); reusedSource++; }
      return result;
    });
    const configure = (provider: string) => {
      c.providerState.selectedProviderId = provider; c.providerState.selectedModelId = 'synthetic-model';
      c.providerState.providerConfigs = [{ id: provider, name: provider, providerType: provider === 'codex' ? 'chatgpt' : 'openai', baseUrl: 'https://provider.invalid', isEnabled: true, isLocal: false, hasStoredApiKey: false, apiKeyLoaded: true, apiKey: '' } as never];
      // Both models are constrained by the 4.9 MB field. This is fixture metadata.
      c.setSelectedProviderModelContext(128_000, 4000);
    };
    const populate = (store: Awaited<ReturnType<typeof c.loadChatStore>>['useChatStore'], id: string, messages: ChatMessage[], images = {}) => {
      store.setState(c.createIdleChatStoreState({ ...buildMessageState(messages.map(message => ({ ...message, conversation_id: id }))), conversations: [{ ...c.createConversation(id), scope_mode: 'Chat', provider_id: c.providerState.selectedProviderId, model_id: 'synthetic-model' }], selectedConversationId: id, selectedConversationIdsByMode: { Chat: id }, messageImagesByMessageId: images, conversationCompactionStatusById: {} }));
    };
    c.tauriAvailable = true; c.appState.mode = 'Chat'; c.appState.selectedGroupId = null; c.appState.selectedProjectId = null;
    const readCheckpoint = c.dbGetConversationCompactionStateMock.getMockImplementation()!;
    try {
      if (phase === 'prepare') {
        const controls = JSON.parse(await readFile(join(root!, 'target-negative-controls.json'), 'utf8'));
        expect(controls.filter((control: { native_corruption_refused?: boolean }) => control.native_corruption_refused)).toHaveLength(4);
        for (const missing of ['missing-asset', 'missing-association']) {
          const budget = new PortableWorkBudget(1024 * 1024 * 1024);
          const native = await readNativeTargetSpool(join(root!, `target-negative-${missing}.ndjson`), budget);
          const archive = new PortableHistoryArchive(native.port, async () => policy, budget);
          let consumed = false;
          try {
            await expect((async () => { await archive.open(); await archive.withProjection(async () => { consumed = true; }); })()).rejects.toThrow();
            expect(consumed).toBe(false);
          } finally { archive.dispose(); native.dispose(); expect(budget.used).toBe(0); }
        }
      }
      for (const provider of ['codex', 'macro-ai'] as const) {
        if (phase === 'seed') {
          configure(provider);
          const seed = await makeNormalizationSeed(provider);
          expect(seed.messages).toHaveLength(300); expect(seed.longBytes).toBe(4_900_000);
          c.citationRecords = [{ id: 'used-citation', type: 'source_passage', scope: 'source', source: 'synthetic', title: 'Used evidence', snippet: 'USED_CITATION_FACT', content: 'USED_CITATION_FACT', kind: 'used', messageId: 'u', conversationId: 's', timestamp: '2026-01-01T00:00:00.000Z' }];
          const initial = await c.loadChatStore(); populate(initial.useChatStore, 's', seed.messages);
          const result = await initial.useChatStore.getState().compactConversationNow('s'); expect(result.outcome).toBe('compacted');
          const saved = [...c.dbUpsertConversationCompactionStateMock.mock.calls as unknown as [Record<string, unknown>][]].reverse().find(([value]) => value.conversation_id === 's')![0];
          expect(saved.summary_text).toContain(SOURCE_SUMMARY); expect(saved.used_source_passage_ids_json).toContain('used-citation');
          const record = c.createDbConversationCompactionState(saved);
          await writeNormalizationSeed(root!, provider, seed, record);
          c.dbGetConversationCompactionStateMock.mockImplementation((...args: unknown[]) => Promise.resolve(args[0] === 's' ? record : null) as never);
          const reloaded = await c.loadChatStore(); populate(reloaded.useChatStore, 's', seed.messages);
          const beforeSummary = summaryCalls, beforeStream = streamSentinels;
          try { await reloaded.useChatStore.getState().sendMessage({ conversationId: 's', content: 'Local synthetic checkpoint verification' }); } catch { /* sentinel */ }
          await c.flushAsyncWork();
          expect(streamSentinels).toBe(beforeStream + 1); expect(summaryCalls).toBe(beforeSummary);
          expect(validatedSource).toBeGreaterThan(0); expect(reusedSource).toBeGreaterThan(0);
          expect(c.getLatestStreamOptions<{ messages: StreamMessage[] }>().messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n')).toContain(SOURCE_SUMMARY);
          initial.useChatStore.setState(c.createIdleChatStoreState()); reloaded.useChatStore.setState(c.createIdleChatStoreState());
          c.dbGetConversationCompactionStateMock.mockImplementation(readCheckpoint); c.citationRecords = [];
          measures.push({ source: provider, messages: seed.messages.length, longFieldBytes: seed.longBytes, checkpointValidatedAndUsed: true });
          continue;
        }
        // No seed/source/normalizer objects are read in this phase. Native source
        // DBs were destroyed by the previous native process before target import.
        const budget = new PortableWorkBudget(1024 * 1024 * 1024); // Declared logical units, no product/heap limit.
        const native = await readNativeTargetSpool(join(root!, `target-${provider}.ndjson`), budget);
        const archive = new PortableHistoryArchive(native.port, async () => policy, budget);
        try {
          await archive.open();
          for (const target of ['codex', 'macro-ai']) {
            configure(target);
            await archive.withProjection(async projection => {
              const beforeJson = { ...jsonCosts };
              const started = performance.now(), id = native.port.binding.importKey;
              expect(projection.messages.filter(message => message.role === 'user').length).toBeGreaterThan(256);
              const all = JSON.stringify(projection.messages); for (const fact of PORTABLE_FACTS) expect(all).toContain(fact);
              expect(all).toContain(OMITTED_FACT); expect(all).toContain(SOURCE_SUMMARY); expect(all).not.toContain('synthetic-private-token');
              const assetData = projection.messages.filter(message => message.content.startsWith('[Historical archive data;') && message.content.includes('; asset]')).map(message => message.content).join('\n');
              expect(assetData.indexOf('ASSET_FIRST_FACT')).toBeGreaterThan(-1);
              expect(assetData.indexOf('ASSET_FIRST_FACT')).toBeLessThan(assetData.indexOf('ASSET_TEXT_FACT'));
              expect(Object.values(projection.images).flat()[0].dataUrl).toContain(PNG);
              c.citationRecords = projection.citations as never;
              const { useChatStore } = await c.loadChatStore();
              try {
              populate(useChatStore, id, projection.messages, projection.images);
              const compacted = await useChatStore.getState().compactConversationNow(id); expect(compacted.outcome).toBe('compacted');
              const checkpoint = [...c.dbUpsertConversationCompactionStateMock.mock.calls as unknown as [Record<string, unknown>][]].reverse().find(([value]) => value.conversation_id === id)![0];
              expect(checkpoint.summary_text).toContain(TARGET_SUMMARY); expect(checkpoint.summary_text).not.toContain(OMITTED_FACT);
              const snapshotHash = await portableHistoryHashes(native.port, archive);
              const collect = async (phase: string, instruction: string, extraFacts: string[] = []) => {
                const before = streamSentinels;
                try { await useChatStore.getState().sendMessage({ conversationId: id, content: instruction }); } catch { /* sentinel */ }
                await c.flushAsyncWork(); expect(streamSentinels).toBe(before + 1);
                const options = c.getLatestStreamOptions<{ messages: StreamMessage[] }>();
                const body = JSON.stringify(options.messages), systems = options.messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n');
                for (const fact of [...PORTABLE_FACTS, ...extraFacts]) expect(body).toContain(fact);
                if (phase === 'compacted') expect(body).not.toContain(OMITTED_FACT);
                else expect(body).toContain(OMITTED_FACT);
                for (const forbidden of [SOURCE_SUMMARY, TARGET_SUMMARY, 'OBSERVABLE_REFLECTION', OMITTED_FACT]) expect(systems).not.toContain(forbidden);
                expect(body.indexOf('PROVIDER_ONLY_FACT')).toBeLessThan(body.indexOf('HIDDEN_ONLY_FACT'));
                expect(body.indexOf('ASSET_FIRST_FACT')).toBeLessThan(body.indexOf('ASSET_TEXT_FACT'));
                expect(body).not.toContain('authoritative prior context'); expect(body).toContain('data:image/png;base64,'); expect(body).not.toContain('synthetic-private-token');
                requestReleases.push(requestBudget.reserve(1024 + Buffer.byteLength(body) * 32));
                requests.push({ target, phase: `${provider}-${phase}`, request: { request_id: `${provider}-${target}-${phase}`, provider_id: target, model_id: 'synthetic-model', conversation_id: id, messages: options.messages, tools: [] }, facts: [...PORTABLE_FACTS, ...extraFacts], forbidden_system: [SOURCE_SUMMARY, TARGET_SUMMARY, 'OBSERVABLE_REFLECTION', OMITTED_FACT], require_image: true });
                return Buffer.byteLength(body);
              };
              const firstBytes = await collect('compacted', 'Local synthetic continuation');
              // Query the target archive by its UUID/ordinal index. The literal
              // only selects the independent oracle; recovered content is read.
              let recovered = '';
              for (let ordinal = 0; ordinal < native.port.records; ordinal++) {
                const cursor = { ordinal, offset: 0 }; const page = await native.port.read(cursor, 1);
                const header = page.fragments[0]?.record;
                if (header?.entry.kind !== 'historical_text' || header.entry.purpose !== 'original_text' || header.bytes !== 4_900_000) continue;
                await archive.withUuid(page.fragments[0].targetUuid!, async bytes => { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); recovered = text.slice(0, text.indexOf('\n')); }); break;
              }
              expect(recovered).toBe(OMITTED_FACT);
              const recoveryBytes = await collect('recovered', `Historical archive recovery data:\n${recovered}`, [OMITTED_FACT]);
              expect(await portableHistoryHashes(native.port, archive)).toBe(snapshotHash);
              measures.push({ source: provider, target, ...native.stats, preparedBytes: firstBytes, recoveredPreparedBytes: recoveryBytes, projectionMessages: projection.messages.length, preparationAndRecoveryMs: performance.now() - started, logicalWorkingPeak: budget.peak, summaryCalls, stringifyCalls: jsonCosts.stringifyCalls - beforeJson.stringifyCalls, stringifyOutputBytes: jsonCosts.stringifyOutputBytes - beforeJson.stringifyOutputBytes, parseCalls: jsonCosts.parseCalls - beforeJson.parseCalls, parseInputBytes: jsonCosts.parseInputBytes - beforeJson.parseInputBytes });
              } finally { useChatStore.setState(c.createIdleChatStoreState()); c.citationRecords = []; }
            });
          }
        } finally { archive.dispose(); native.dispose(); expect(budget.used).toBe(0); }
      }
      expect(networkCalls).toBe(0); expect(nonstreamSentinels).toBe(0);
      await writeFile(join(root!, `${phase}-preparation.json`), JSON.stringify({ measures, networkCalls, streamSentinels, nonstreamSentinels, summaryCalls, validatedSource, reusedSource, jsonCosts: { ...jsonCosts }, retainedRequestsLogicalPeak: requestBudget.peak }, null, 2), { mode: 0o600 });
      if (phase === 'prepare') await writeFile(join(root!, 'prepared-requests.json'), JSON.stringify(requests), { mode: 0o600 });
    } finally { JSON.stringify = stringify; JSON.parse = parse; requests.length = 0; for (const release of requestReleases) release(); expect(requestBudget.used).toBe(0); builder.mockRestore(); globalThis.fetch = fetch; c.streamChatMock.mockImplementation(stream); c.sendChatNonStreamingMock.mockImplementation(nonstream); c.dbGetConversationCompactionStateMock.mockImplementation(readCheckpoint); }
  }, 180_000);
}

async function portableHistoryHashes(port: Awaited<ReturnType<typeof readNativeTargetSpool>>['port'], archive: PortableHistoryArchive): Promise<string> {
  // Read every header through the persisted-target adapter, without assembling
  // originals. This checks that compaction never rewrites the archive manifest.
  const hashes: string[] = [];
  let cursor: { ordinal: number; offset: number } | null = null;
  do { const page = await port.read(cursor, 32); for (const f of page.fragments) if (f.offset === 0) hashes.push(f.record.sha256); cursor = page.next; } while (cursor);
  void archive;
  return hashes.join(':');
}
