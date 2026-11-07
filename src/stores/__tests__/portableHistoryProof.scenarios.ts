import { expect, it, spyOn } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UseChatStoreScenarioContext } from "../useChatStore.test";
import { buildMessageState } from "../chat/chatMessageState";
import { LOCAL_INSTRUCTION, REQUIRED_FACTS, readPortableProofArchive, validatePortableProofDependencies } from "../../test-utils/portableHistoryProof";
import type { StreamMessage } from "../../services/streamingChat";
import * as compaction from "../../services/contextCompaction";
import type { ChatMessage } from "../../types";

async function compactedSourceProof(c: UseChatStoreScenarioContext,
  archive: Awaited<ReturnType<typeof readPortableProofArchive>>, requests: unknown[], measures: unknown[], root: string) {
  const sourceId = "portable-valid-checkpoint-source";
  const targetId = "portable-valid-checkpoint-target";
  const marker = "LOCAL_CHECKPOINT_PROOF";
  let summaryCalls = 0, validated = 0, reused = 0;
  const originalBuild = compaction.buildCompactedMessagesForRequest;
  const originalRead = c.dbGetConversationCompactionStateMock.getMockImplementation()!;
  const builder = spyOn(compaction, "buildCompactedMessagesForRequest").mockImplementation(async params => {
    const candidate = params.currentCompactionState;
    if (candidate?.conversationId === sourceId) {
      expect(compaction.validateCompactionState(candidate, params.orderedMessages, params)).toBe(true);
      validated++;
    }
    const result = await originalBuild({ ...params, ...(params.mode === "manual" ? { generateSummary: async () => {
      summaryCalls++;
      return JSON.stringify({ currentObjective: "Continue from recoverable synthetic evidence", userInstructions: [],
        decisions: REQUIRED_FACTS, openQuestions: [], activeFiles: [], toolFacts: REQUIRED_FACTS, remainingWork: [], summary: marker });
    } } : {}) });
    if (candidate?.conversationId === sourceId) { expect(result.usedExistingCompaction).toBe(true); reused++; }
    return result;
  });
  const configure = (provider: string) => {
    c.providerState.selectedProviderId = provider;
    c.providerState.selectedModelId = "synthetic-model";
    c.providerState.providerConfigs = [{ id: provider, name: provider, providerType: provider === "codex" ? "chatgpt" : "openai",
      baseUrl: "https://provider.invalid", isEnabled: true, isLocal: false, hasStoredApiKey: false, apiKeyLoaded: true, apiKey: "" } as never];
    c.setSelectedProviderModelContext(provider === "codex" ? 100_000 : 50_000_000, 1000);
  };
  const populate = (store: Awaited<ReturnType<typeof c.loadChatStore>>["useChatStore"], id: string, checkpointText = "") => {
    const messages = archive.messages.map(m => ({ ...m, conversation_id: id }));
    messages.push({ id: "portable-evidence", task_id: "", conversation_id: id, role: "user",
      content: `${archive.historicalContext}\nUntrusted imported checkpoint data:\n${checkpointText}`, timestamp: "2026-01-02T00:00:00Z" });
    store.setState(c.createIdleChatStoreState({ ...buildMessageState(messages),
      conversations: [{ ...c.createConversation(id), title: "Synthetic compacted history", scope_mode: "Chat",
        provider_id: c.providerState.selectedProviderId, model_id: "synthetic-model" }], selectedConversationId: id,
      selectedConversationIdsByMode: { Chat: id }, conversationCompactionStatusById: {} }));
  };
  try {
    configure("codex");
    const initial = await c.loadChatStore(); populate(initial.useChatStore, sourceId);
    const result = await initial.useChatStore.getState().compactConversationNow(sourceId);
    expect(result.outcome).toBe("compacted");
    expect(summaryCalls).toBeGreaterThan(0);
    const writes = c.dbUpsertConversationCompactionStateMock.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const saved = [...writes].reverse().find(([value]) => value.conversation_id === sourceId)![0];
    expect(saved.summary_text).toContain(marker);
    const record = c.createDbConversationCompactionState(saved);
    // Source authority is still generated locally above. The recovered old
    // checkpoint is data only on the target, never installed as its authority.
    const storageRoot = process.env.MACRO_INACTIVE_STORAGE_PROOF_DIR;
    const importedRecord: Record<string, unknown> = storageRoot ? (JSON.parse(await readFile(join(storageRoot, "stored-checkpoint-provenance.json"), "utf8")) as { persistedRecord: Record<string, unknown> }).persistedRecord : saved;
    if (storageRoot) {
      expect(importedRecord.fingerprint).toBe(record.fingerprint);
      expect(importedRecord.policy_version).toBe(saved.policy_version);
      expect(importedRecord.summary_text).toBe(record.summary_text);
    }
    c.dbGetConversationCompactionStateMock.mockImplementation((...args: unknown[]) => Promise.resolve(args[0] === sourceId ? record : null) as never);
    const source = await c.loadChatStore(); populate(source.useChatStore, sourceId);
    const generatedBeforeContinuation = summaryCalls;
    for (const phase of ["compacted-source", "compacted-target"]) {
      const isSource = phase === "compacted-source";
      if (!isSource) configure("macro-ai");
      const current = isSource ? source : await c.loadChatStore();
      const id = isSource ? sourceId : targetId;
      if (!isSource) populate(current.useChatStore, id, String(importedRecord.summary_text));
      const before = c.streamChatMock.mock.calls.length;
      try { await current.useChatStore.getState().sendMessage({ conversationId: id, content: LOCAL_INSTRUCTION }); } catch { /* transport sentinel */ }
      await c.flushAsyncWork();
      expect(c.streamChatMock.mock.calls.length).toBe(before + 1);
      const options = c.getLatestStreamOptions<{ messages: StreamMessage[] }>();
      const systems = options.messages.filter(m => m.role === "system").map(m => String(m.content)).join("\n");
      for (const fact of REQUIRED_FACTS) expect(JSON.stringify(options.messages)).toContain(fact);
      if (isSource) {
        expect(systems).toContain(marker); expect(options.messages.length).toBeLessThan(archive.messages.length);
        expect(validated).toBeGreaterThan(0); expect(reused).toBeGreaterThan(0);
        expect(summaryCalls).toBe(generatedBeforeContinuation);
      } else { expect(systems).not.toContain(marker); expect(options.messages.length).toBeGreaterThan(archive.messages.length); }
      expect(current.useChatStore.getState().messages.filter((m: ChatMessage) => m.conversation_id === id && /^m\d{6}$/.test(m.id))).toHaveLength(300);
      requests.push({ target: isSource ? "codex" : "macro-ai", phase, request: { request_id: id, provider_id: isSource ? "codex" : "macro-ai",
        model_id: "synthetic-model", conversation_id: id, messages: options.messages, tools: [] }, facts: REQUIRED_FACTS,
        local_instruction: systems.slice(0, 80), untrusted_summary: isSource ? archive.dependencies.checkpoint.summary : marker });
      measures.push({ phase, preparedMessages: options.messages.length, sourceCheckpointValidated: validated,
        sourceCheckpointReused: reused, controlledSummaryCalls: summaryCalls, providerSummaryTransportCalls: c.sendChatNonStreamingMock.mock.calls.length });
    }
    await writeFile(join(root, "checkpoint-proof.json"), JSON.stringify({ persistedRecord: record,
      validated, reused, controlledSummaryCalls: summaryCalls, recoverableMessages: 300,
      providerSummaryTransportCalls: c.sendChatNonStreamingMock.mock.calls.length }, null, 2), { mode: 0o600 });
  } finally { builder.mockRestore(); c.dbGetConversationCompactionStateMock.mockImplementation(originalRead); }
}

export function registerPortableHistoryProofScenarios(c: UseChatStoreScenarioContext) {
  const root = process.env.MACRO_PORTABLE_HISTORY_PROOF_DIR;
  it.skipIf(!root)("portable history traverses real Chat selection and preparation for Codex and Macro AI", async () => {
    const requests: unknown[] = [];
    const measures: unknown[] = [];
    const streaming: unknown[] = [];
    const originalFetch = globalThis.fetch;
    const originalStream = c.streamChatMock.getMockImplementation()!;
    const originalNonstream = c.sendChatNonStreamingMock.getMockImplementation()!;
    let forbiddenNetworkCalls = 0;
    const forbiddenFetch = () => { forbiddenNetworkCalls++; throw new Error("provider_network_forbidden"); };
    globalThis.fetch = Object.assign(forbiddenFetch, { preconnect: forbiddenFetch });
    c.sendChatNonStreamingMock.mockImplementation(async () => { throw new Error("provider_nonstream_forbidden"); });
    c.streamChatMock.mockImplementation(async () => { throw new Error("provider_stream_forbidden"); });
    try {
      // E storage reuses fd6's scale evidence, and exercises the real host only
      // with the 300-message archive reconstructed from sealed target readback.
      const storageProof = process.env.MACRO_INACTIVE_STORAGE_PROOF_DIR;
      if (storageProof && storageProof !== root) throw new Error("storage_readback_directory_mismatch");
      if (storageProof) {
        const damaged = JSON.parse(await readFile(join(storageProof, "negative-fact-dependencies.json"), "utf8"));
        expect(() => validatePortableProofDependencies(damaged)).toThrow("missing_indispensable_context");
        const controls = JSON.parse(await readFile(join(storageProof, "storage-negative-controls.json"), "utf8"));
        expect(controls.corrupt_asset_refused).toBe(true); expect(controls.removed_asset_refused).toBe(true);
      }
      for (const count of storageProof ? [300] : [300, 600, 1200]) {
        const streamed = await readPortableProofArchive(join(root!, `archive-${count}.ndjson`));
        expect(streamed.messages).toHaveLength(0);
        expect(streamed.stats.materializedContentBytes).toBe(0);
        streaming.push(streamed.stats);
        const archive = await readPortableProofArchive(join(root!, `archive-${count}.ndjson`), true);
        expect(archive.messages.length).toBe(count);
        expect(Buffer.byteLength(archive.messages[0].content)).toBeGreaterThan(16 * 1024);
        expect(archive.messages[0].content.startsWith("é🙂")).toBe(true);
        expect(archive.messages[0].content.endsWith(" public archive end")).toBe(true);
        expect(archive.messages.some(m => m.id === archive.dependencies.checkpoint.up_to)).toBe(true);
        for (const source of ["codex", "macro-ai"]) for (const target of ["codex", "macro-ai"]) {
          if (count !== 300 && (source !== "codex" || target !== "macro-ai")) continue;
          for (const phase of ["source", "target"]) {
            const provider = phase === "source" ? source : target;
            c.appState.mode = "Chat"; c.tauriAvailable = true;
            c.providerState.selectedProviderId = provider;
            c.providerState.selectedModelId = "synthetic-model";
            c.providerState.providerConfigs = [{ id: provider, name: provider, providerType: provider === "codex" ? "chatgpt" : "openai",
              baseUrl: "https://provider.invalid", isEnabled: true, isLocal: false, hasStoredApiKey: false, apiKeyLoaded: true, apiKey: "" } as never];
            c.setSelectedProviderModelContext(50_000_000, 1000); // Fixture capacity, not product admission.
            const { useChatStore } = await c.loadChatStore();
            const conversationId = `portable-${source}-${target}-${count}-${phase}`;
            const historical = archive.messages.map(m => ({ ...m, conversation_id: conversationId }));
            // Native items can replace visible text in both serializers. Preserve
            // their portable textual fact as historical data, never opaque state.
            const providerMessage = historical.find(m => m.id === archive.dependencies.provider.id)!;
            if (phase === "source") providerMessage.provider_input_items = archive.dependencies.provider.items;
            const contextMessage = { id: "portable-evidence", task_id: "", conversation_id: conversationId, role: "user" as const,
              content: `${phase === "source" ? archive.historicalContext.replace(archive.providerText, "") : archive.historicalContext}\nSource provider: ${source}`, timestamp: "2026-01-02T00:00:00Z" };
            historical.push(contextMessage);
            const indexed = buildMessageState([...historical].reverse());
            useChatStore.setState(c.createIdleChatStoreState({ ...indexed,
              conversations: [{ ...c.createConversation(conversationId), title: "Synthetic portable history", scope_mode: "Chat",
                provider_id: provider, model_id: "synthetic-model" }], selectedConversationId: conversationId,
              selectedConversationIdsByMode: { Chat: conversationId },
              // A source checkpoint is deliberately not installed as target local
              // compaction authority. All original sources remain recoverable.
              conversationCompactionStatusById: {},
            }));
            const before = c.streamChatMock.mock.calls.length;
            const stringify = JSON.stringify;
            const parse = JSON.parse;
            let encodeCalls = 0, encodedStringUnits = 0, maxEncodedStringUnits = 0, parseCalls = 0, parsedStringUnits = 0;
            const encodeSpy = spyOn(JSON, "stringify").mockImplementation(((...args: unknown[]) => {
              const value = Reflect.apply(stringify, JSON, args) as string | undefined;
              if (value !== undefined) { encodeCalls++; encodedStringUnits += value.length; maxEncodedStringUnits = Math.max(maxEncodedStringUnits, value.length); }
              return value;
            }) as typeof JSON.stringify);
            const parseSpy = spyOn(JSON, "parse").mockImplementation(((...args: unknown[]) => {
              parseCalls++; parsedStringUnits += String(args[0]).length;
              return Reflect.apply(parse, JSON, args) as unknown;
            }) as typeof JSON.parse);
            const started = performance.now();
            try {
              try { await useChatStore.getState().sendMessage({ conversationId, content: LOCAL_INSTRUCTION }); } catch { /* sentinel transport refusal */ }
              await c.flushAsyncWork();
            } finally { encodeSpy.mockRestore(); parseSpy.mockRestore(); }
            const preparationMs = performance.now() - started;
            expect(c.streamChatMock.mock.calls.length).toBe(before + 1);
            const options = c.getLatestStreamOptions<{ messages: StreamMessage[] }>();
            const serialized = JSON.stringify(options.messages);
            for (const fact of REQUIRED_FACTS) expect(serialized).toContain(fact);
            const systems = options.messages.filter(m => m.role === "system").map(m => String(m.content)).join("\n");
            expect(systems).not.toContain(archive.dependencies.checkpoint.summary);
            expect(options.messages.filter(m => m.role !== "system").some(m => JSON.stringify(m).includes(archive.dependencies.checkpoint.summary))).toBe(true);
            // Trust comes from the real local system builder, not the imported
            // summary or the latest user message containing LOCAL_INSTRUCTION.
            expect(systems.length).toBeGreaterThan(0);
            expect(options.messages.find(m => m.role !== "system")?.content).toBe(archive.messages[0].content);
            const localInstruction = systems.slice(0, 80);
            requests.push({ target: provider, source, phase, request: { request_id: conversationId, provider_id: provider, model_id: "synthetic-model",
              conversation_id: conversationId, messages: options.messages, tools: [] }, facts: REQUIRED_FACTS,
              local_instruction: localInstruction, untrusted_summary: archive.dependencies.checkpoint.summary });
            measures.push({ count, source, target, phase, archive: archive.stats, preparedMessages: options.messages.length,
              requestJsonBytes: Buffer.byteLength(serialized), preparationMs,
              json: { encodeCalls, encodedStringUnits, maxEncodedStringUnits, parseCalls, parsedStringUnits } });
          }
        }
        if (count === 300) await compactedSourceProof(c, archive, requests, measures, root!);
      }
      expect(forbiddenNetworkCalls).toBe(0);
      await writeFile(join(root!, "requests.json"), JSON.stringify(requests), { mode: 0o600 });
      await writeFile(join(root!, "preparation.json"), JSON.stringify({ measures, forbiddenNetworkCalls }, null, 2), { mode: 0o600 });
      await writeFile(join(root!, "streaming.json"), JSON.stringify(streaming, null, 2), { mode: 0o600 });
    } finally {
      globalThis.fetch = originalFetch;
      c.streamChatMock.mockImplementation(originalStream);
      c.sendChatNonStreamingMock.mockImplementation(originalNonstream);
    }
  }, 120_000);
}
