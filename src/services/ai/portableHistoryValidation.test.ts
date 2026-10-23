import { expect, test } from 'bun:test';
import { checkpointFixture, fixture, policy } from './portableHistoryFixtures.testSupport';
import { normalizePortableChatHistoryTwoPass, type PortableRecord } from './portableChatHistory';
import { buildToolContextBlock, formatToolTraceDetail } from './toolPresentation';
import { buildAssistantProviderInputItemsFromTurn, buildFunctionCallOutputProviderInputItem } from './responsesCodec';
import { PortableHistoryArchive, type PortableArchiveFragment, type PortableArchivePort } from './portableHistoryArchive';
import { PortableWorkBudget } from './portableHistoryInspection';
import { createCompactionTextFingerprint } from '../contextCompaction';
const encoder = new TextEncoder();

async function refuseBeforeAppend(f: Awaited<ReturnType<typeof fixture>>, error: string) {
  let writes = 0;
  await expect(normalizePortableChatHistoryTwoPass(f.source, async () => policy, f.budget, { append: async () => { writes++; } })).rejects.toThrow(error);
  expect(writes).toBe(0); expect(f.budget.used).toBe(0);
}

test('every retained checkpoint JSON inspects decoded keys and strings before destination writes', async () => {
  for (const tag of [3, 4, 5, 10, 12, 13]) {
    const f = await checkpointFixture();
    const value = tag === 3 ? [{ tool_name: 'read_sources', target: '', kind: 'tool_result', evidence_excerpt: 'synthetic-private-token', source_message_id: 'u', hash: 'fixture' }]
      : [4, 5, 10].includes(tag) ? ['synthetic-private-token'] : { 'synthetic-private-token': 'diagnostic' };
    await f.change(5, tag, JSON.stringify(value).replace('synthetic-private-token', 'synthetic-private-\\u0074oken'));
    await refuseBeforeAppend(f, 'unsafe_content');
  }
  const unknown = await checkpointFixture();
  await unknown.change(5, 3, '{"remote_required_context":{"file":"unavailable"}}');
  await refuseBeforeAppend(unknown, 'unknown_required_shape');
});

test('captured checkpoint lists, boundary, complete prefix and hashes agree with real fingerprint inputs', async () => {
  const valid = await checkpointFixture();
  // The real preparer may prune a message in the retained tail as well.
  await valid.change(5, 10, '["a"]'); await valid.run(); expect(valid.budget.used).toBe(0);
  for (const [tag, value, error] of [
    [4, '["missing-required-citation"]', 'checkpoint_source_missing'],
    [5, '["used"]', 'checkpoint_source_missing'],
    [4, '{"ids":[]}', 'unknown_required_shape'],
    [5, '[17]', 'unknown_required_shape'],
    [10, '["not-a-prefix-message"]', 'checkpoint_source_missing'],
    [4, '["used","used"]', 'unknown_required_shape'],
    [1, 'missing-boundary', 'checkpoint_source_missing'],
    [21, '{"used":"stale"}', 'checkpoint_source_missing'],
  ] as const) {
    const f = await checkpointFixture(); await f.change(5, tag, value); await refuseBeforeAppend(f, error);
  }
  for (const tag of [9, 19, 22]) {
    const f = await checkpointFixture(); await f.change(5, tag, 1n); await refuseBeforeAppend(f, 'checkpoint_source_missing');
  }
  for (const missing of ['message', 'citation']) {
    const f = await checkpointFixture(), original = f.source.rows.bind(f.source);
    f.source.rows = async function* () { for await (const row of original()) if (!(row.family === (missing === 'message' ? 1 : 6) && new TextDecoder().decode(f.data.get(row.fields[0].ordinal)) === (missing === 'message' ? 'u' : 'used'))) yield row; };
    await refuseBeforeAppend(f, 'checkpoint_source_missing');
  }
  const stale = await checkpointFixture();
  await stale.change(1, 4, 'A changed original message'); await refuseBeforeAppend(stale, 'checkpoint_source_missing');
});

test('private checkpoint bindings are used locally without inspecting or exporting their opaque values', async () => {
  const f = await checkpointFixture(), inputs = JSON.parse(f.state.fingerprintInputsJson!);
  inputs.systemHash = 'synthetic-private-token';
  const raw = JSON.stringify(inputs), hash = createCompactionTextFingerprint(); hash.update(raw);
  await f.change(5, 20, raw); await f.change(5, 8, hash.finish());
  await f.run();
  expect(JSON.stringify(f.output)).not.toContain('synthetic-private-token');
  for (const tag of [8, 20, 21]) {
    const origins = f.output.filter(item => item.header.entry.kind === 'historical_text' && item.header.entry.purpose === 'portable_metadata').map(item => JSON.parse(item.text)).filter(item => item.source.family === 5 && item.source.tag === tag);
    expect(origins).toHaveLength(1); expect(origins[0].classification).toBe('excluded_local_metadata'); expect(origins[0].sourceHash).toBeUndefined(); expect(origins[0].sourceBytes).toBeUndefined();
  }
  expect(f.budget.used).toBe(0);
});

async function structuredHidden(change?: (messages: unknown[][]) => void, delimiters = false) {
  return fixture('codex', messages => {
    const calls = ['first', 'second'].map(id => ({ id, type: 'function' as const, function: { name: 'read_sources', arguments: JSON.stringify({ query: id }) } }));
    const results = [delimiters ? 'Exact </tool_context> and <tool_context boundary' : 'FIRST_COMPLETE_RESULT', 'SECOND_COMPLETE_RESULT'];
    const traces = calls.map(call => ({ tool_call_id: call.id, tool_name: call.function.name, detail: formatToolTraceDetail(call.function.name, JSON.parse(call.function.arguments)), status: 'done' }));
    messages[1][9] = JSON.stringify([...buildAssistantProviderInputItemsFromTurn('', calls), ...calls.map((call, i) => buildFunctionCallOutputProviderInputItem(call.id, results[i])), ...buildAssistantProviderInputItemsFromTurn('A complete final answer.', [])]);
    messages[1][7] = JSON.stringify(traces);
    messages[1][8] = calls.map((call, i) => buildToolContextBlock(call.id, call.function.name, traces[i].detail, results[i])).join('\n\n');
    change?.(messages);
  });
}

test('hidden matches the entire real formatter output and traces, including result delimiters', async () => {
  for (const delimiters of [false, true]) {
    const f = await structuredHidden(undefined, delimiters); await f.run();
    const origins = f.output.filter(item => item.header.entry.kind === 'historical_text' && item.header.entry.purpose === 'portable_metadata').map(item => JSON.parse(item.text));
    expect(origins.some(origin => origin.reason === 'hidden_matches_complete_structured_results' && origin.classification === 'redundant_representation')).toBe(true);
    expect(origins.filter(origin => origin.source.family === 1 && origin.source.tag === 8 && origin.classification === 'retained_original').map(origin => origin.meaning)).toEqual(['original']);
    expect(f.budget.used).toBe(0);
  }
  for (const change of [
    (messages: unknown[][]) => { messages[1][8] = String(messages[1][8]).replace('FIRST_COMPLETE_RESULT', 'CONTRADICTORY_RESULT'); },
    (messages: unknown[][]) => { messages[1][8] = String(messages[1][8]).replace('tool_call_id="first"', 'tool_call_id="other"'); },
    (messages: unknown[][]) => { messages[1][8] = String(messages[1][8]).replace('tool="read_sources"', 'tool="web_search"'); },
    (messages: unknown[][]) => { messages[1][8] = String(messages[1][8]).replace('detail="query=first"', 'detail="other"'); },
    (messages: unknown[][]) => { messages[1][8] = String(messages[1][8]).split('\n\n').reverse().join('\n\n'); },
    (messages: unknown[][]) => { messages[1][7] = JSON.stringify(JSON.parse(String(messages[1][7])).reverse()); messages[1][8] = String(messages[1][8]).split('\n\n').reverse().join('\n\n'); },
    (messages: unknown[][]) => { const traces = JSON.parse(String(messages[1][7])); traces[0].detail = 'other'; messages[1][7] = JSON.stringify(traces); messages[1][8] = String(messages[1][8]).replace('detail="query=first"', 'detail="other"'); },
  ]) await refuseBeforeAppend(await structuredHidden(change), 'contradictory_result');
  const hiddenOnly = await fixture('codex'); await hiddenOnly.run(); expect(JSON.stringify(hiddenOnly.output)).toContain('HIDDEN_ONLY_FACT');
});

function portFor(output: { header: PortableRecord; text: string }[]): PortableArchivePort {
  const fragments: PortableArchiveFragment[] = [];
  for (const { header, text } of output) {
    const bytes = encoder.encode(text), targetUuid = header.entry.kind === 'association' ? null : `00000000-0000-4000-8000-${String(header.ordinal).padStart(12, '0')}`;
    if (!bytes.length) fragments.push({ record: header, offset: 0, bytes, targetUuid });
    for (let offset = 0; offset < bytes.length; offset += 4093) fragments.push({ record: header, offset, bytes: bytes.slice(offset, offset + 4093), targetUuid });
  }
  return { profile: 'portable_chat_history_v1', binding: { version: 1, importKey: 'test', manifest: 'b'.repeat(64) }, records: output.length,
    async read(cursor, limit) { const start = cursor ? fragments.findIndex(fragment => fragment.record.ordinal === cursor.ordinal && fragment.offset === cursor.offset) : 0; const next = fragments[start + limit]; return { fragments: fragments.slice(start, start + limit), next: next ? { ordinal: next.record.ordinal, offset: 0 } : null }; } };
}

test('source-approved JSON is inspected decoded again under a stronger target policy of the same revision', async () => {
  const targetSecret = 'new-target-secret';
  const f = await fixture('codex');
  // Replace the actual inner argument string through the producer envelope.
  const items = JSON.parse(new TextDecoder().decode(f.data.get(f.rows[2].fields[9].ordinal)));
  items[0].arguments = '{"integer":9007199254740993,"overflow":1e400,"location":"new-target-\\u0073ecret"}';
  const field = f.rows[2].fields[9], bytes = encoder.encode(JSON.stringify(items));
  const { portableDigest } = await import('./portableChatHistory');
  Object.assign(field, { bytes: bytes.length, sha256: await portableDigest(bytes) }); f.data.set(field.ordinal, bytes);
  await f.run();
  const raw = f.output.find(record => record.text.includes('arguments_json'))!;
  expect(JSON.parse(raw.text).arguments_json).toBe(items[0].arguments);
  const budget = new PortableWorkBudget(128 * 1024 * 1024), stronger = { ...policy, secrets: [...policy.secrets, targetSecret] };
  const archive = new PortableHistoryArchive(portFor(f.output), async () => stronger, budget); await archive.open();
  await expect(archive.withRecord(raw.header.ordinal, async () => {})).rejects.toThrow('unsafe_content');
  await expect(archive.withUuid(`00000000-0000-4000-8000-${String(raw.header.ordinal).padStart(12, '0')}`, async () => {})).rejects.toThrow('unsafe_content');
  await expect(archive.withProjection(async () => {})).rejects.toThrow('unsafe_content');
  archive.dispose(); expect(budget.used).toBe(0);
});

test('reader open inspects escaped metadata and checkpoint JSON under the target policy, without parsing user prose', async () => {
  const { portableDigest } = await import('./portableChatHistory');
  const stronger = { ...policy, secrets: [...policy.secrets, 'new-target-secret'] };
  for (const where of ['metadata', 'checkpoint']) {
    const f = await checkpointFixture();
    if (where === 'checkpoint') await f.change(5, 3, '[{"tool_name":"read_sources","target":"","kind":"tool_result","evidence_excerpt":"new-target-\\u0073ecret","source_message_id":"u","hash":"fixture"}]');
    await f.run();
    if (where === 'metadata') {
      const record = f.output.find(item => item.header.entry.kind === 'historical_text' && item.header.entry.purpose === 'portable_metadata' && !JSON.parse(item.text).captureManifest)!;
      const value = JSON.parse(record.text); value.reason = 'new-target-secret';
      record.text = JSON.stringify(value).replace('new-target-secret', 'new-target-\\u0073ecret');
      const bytes = encoder.encode(record.text); record.header.bytes = bytes.length; record.header.sha256 = await portableDigest(bytes);
    }
    const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(f.output), async () => stronger, budget);
    let consumed = false;
    if (where === 'metadata') await expect(archive.open()).rejects.toThrow('unsafe_content');
    else {
      await archive.open();
      const record = f.output.find(item => item.header.origin !== undefined && item.text.includes('new-target-'))!;
      await expect(archive.withRecord(record.header.ordinal, async () => { consumed = true; })).rejects.toThrow('unsafe_content');
      await expect(archive.withUuid(`00000000-0000-4000-8000-${String(record.header.ordinal).padStart(12, '0')}`, async () => { consumed = true; })).rejects.toThrow('unsafe_content');
      await expect(archive.withProjection(async () => { consumed = true; })).rejects.toThrow('unsafe_content');
    }
    expect(consumed).toBe(false); archive.dispose(); expect(budget.used).toBe(0);
  }
  const raw = '{"prose":"new-target-\\u0073ecret"}', f = await fixture('codex', messages => { messages[0][4] = raw; }); await f.run();
  const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(f.output), async () => stronger, budget); await archive.open();
  await archive.withProjection(async projection => { expect(projection.messages.find(message => message.role === 'user')!.content).toBe(raw); });
  archive.dispose(); expect(budget.used).toBe(0);
});

test('provider finals and Macro AI visible reflection stay recoverable but project exactly one assistant final', async () => {
  for (const provider of ['codex', 'macro-ai'] as const) {
    const f = await fixture(provider); await f.run();
    expect(f.output.filter(item => item.text === 'A complete final answer.').length).toBeGreaterThan(1);
    expect(f.output.some(item => item.text.includes(f.reflection))).toBe(true);
    const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(f.output), async () => policy, budget); await archive.open();
    await archive.withProjection(async projection => {
      const matches = projection.messages.filter(message => message.content.includes('A complete final answer.'));
      expect(matches).toHaveLength(1); expect(matches[0].role).toBe('assistant'); expect(matches[0].content).toBe('A complete final answer.');
      expect(projection.messages.some(message => message.content.includes(f.reflection))).toBe(false);
    });
    archive.dispose(); expect(budget.used).toBe(0);
  }
});

test('structured hidden refuses missing traces and contradictory trace/provider names', async () => {
  const missing = await structuredHidden(messages => { messages[1][7] = '[]'; }); await refuseBeforeAppend(missing, 'incomplete_result');
  const traceName = await structuredHidden(messages => {
    const traces = JSON.parse(String(messages[1][7])); traces[0].tool_name = 'web_search'; messages[1][7] = JSON.stringify(traces);
    messages[1][8] = String(messages[1][8]).replace('tool="read_sources"', 'tool="web_search"');
  }); await refuseBeforeAppend(traceName, 'contradictory_result');
  const providerName = await fixture('macro-ai', messages => {
    const items = JSON.parse(String(messages[1][9])); items[1].tool_name = 'wrong_tool'; messages[1][9] = JSON.stringify(items);
  }); await refuseBeforeAppend(providerName, 'contradictory_result');
  const final = await fixture('codex', messages => {
    const items = JSON.parse(String(messages[1][9])); items.splice(items.length - 1, 0, ...buildAssistantProviderInputItemsFromTurn('Distinct intermediate assistant text', [])); messages[1][9] = JSON.stringify(items);
  }); await final.run();
  const budget = new PortableWorkBudget(128 * 1024 * 1024), archive = new PortableHistoryArchive(portFor(final.output), async () => policy, budget); await archive.open();
  await archive.withProjection(async projection => {
    expect(projection.messages.some(message => message.content.includes('Distinct intermediate assistant text'))).toBe(true);
    expect(projection.messages.filter(message => message.content === 'A complete final answer.')).toHaveLength(1);
  });
  archive.dispose(); expect(budget.used).toBe(0);
});

test('hidden-only formatter attributes are inspected after its own entity decoding', async () => {
  const secret = 'attribute<&"secret', f = await fixture('codex', messages => { messages[1][8] = buildToolContextBlock('hidden', 'read_sources', secret, 'Complete legacy hidden-only result'); });
  let writes = 0;
  await expect(normalizePortableChatHistoryTwoPass(f.source, async () => ({ ...policy, secrets: [...policy.secrets, secret] }), f.budget, { append: async () => { writes++; } })).rejects.toThrow('unsafe_content');
  expect(writes).toBe(0); expect(f.budget.used).toBe(0);
});

test('decoded surrogates refuse before provider derivation or destination writes, without rewriting argument lexemes', async () => {
  for (const where of ['text', 'argument', 'name']) {
    const f = await fixture('codex', messages => {
      const items = JSON.parse(String(messages[1][9]));
      if (where === 'text') items.at(-1).content[0].text = '\uD800';
      else if (where === 'name') items[0].name = '\uDC00';
      else items[0].arguments = '{"required":"\\ud800"}';
      messages[1][9] = JSON.stringify(items);
    });
    await refuseBeforeAppend(f, 'invalid_portable_unicode');
  }
});
