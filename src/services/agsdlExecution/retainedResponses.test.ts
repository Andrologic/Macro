import { describe, expect, it } from 'bun:test';
import { contextFixture, id, json } from './conformanceFixtures';
import { decode, encode, record } from './exact';
import { closeRetainedResponses, validateRetainedResponses, type RetainedEmission } from './retainedResponses';

const context = contextFixture();
const interfaceJson = json('{"results":{"report":{"required":true,"mediaTypes":["application/json"],"valueSchema":{"type":"integer","enum":[9007199254740993]}}}}');
const options = { context, interfaceJson, stepJson: json('{"type":"agent","agent":"worker"}'), publicationContractJson: encode({ protocol: 'macro-agsdl-publication/1', registryVersion: context.registryVersion, agent: 'worker', step: ['work'], interface: decode(interfaceJson), choices: [], decisionBinding: null }) };
const emission = (sequence: string, kind: RetainedEmission['kind'], bodyJson: RetainedEmission['bodyJson']): RetainedEmission => ({ context, providerAttemptId: id('native-attempt'), sequence: id(sequence), identity: `emission-${sequence}`, kind, bodyJson });
const publication = (sequence: string, rawArguments = '{"results":{"report":{"value":9007199254740993,"mediaType":"application/json"}}}') => emission(sequence, 'publication', encode({ rawArguments }));

describe('retained native response validation', () => {
  it('retains raw numbers and the real visible sequence across successful closure', async () => {
    const retained = { digest: 'native-digest', events: [emission('1', 'message', encode({ textParts: ['first', '\nsecond'] })), publication('2')] };
    const result = await validateRetainedResponses(options, retained);
    expect(result.cursor).toBe(id<'sequence'>('2'));
    expect(result.validation.kind).toBe('success');
    if (result.validation.kind !== 'success') throw new Error('unexpected failure');
    expect(result.validation.text).toBe('first\nsecond');
    expect(result.validation.resultsJson).toContain('9007199254740993');
    let seen = false;
    const closed = await closeRetainedResponses(options, { read: async () => retained, close: async closure => {
      seen = true; expect(closure.digest).toBe(retained.digest); expect(closure.cursor).toBe(id<'sequence'>('2')); return closure;
    } });
    expect(seen).toBe(true); expect(closed.validation).toEqual(result.validation);
  });
  it('closes missing, malformed and contradictory outputs as failure without discarding their cursor', async () => {
    for (const events of [[], [publication('1', '{broken')], [publication('1'), publication('2')], [emission('1', 'rejectedPublication', encode({ rawArguments: '{"results":{}}' }))]]) {
      const retainedBytes = events.map(event => event.bodyJson);
      const result = await validateRetainedResponses(options, { digest: 'native', events });
      expect(result.cursor).toBe(id<'sequence'>(String(events.length)));
      expect(result.validation).toMatchObject({ kind: 'failure', code: 'OUTPUT_CONSTRAINT' });
      expect(events.map(event => event.bodyJson)).toEqual(retainedBytes);
    }
  });
  it('never disguises transport holes or another epoch as an output failure', async () => {
    for (const events of [[publication('2')], [{ ...publication('1'), context: { ...context, owner: { ...context.owner, ownerEpoch: id<'ownerEpoch'>('4') } } }]]) {
      let closeCalled = false;
      await expect(closeRetainedResponses(options, { read: async () => ({ digest: 'native', events }), close: async receipt => { closeCalled = true; return receipt; } })).rejects.toMatchObject({ code: 'CORRELATION' });
      expect(closeCalled).toBe(false);
    }
  });
  it('does not turn a native refusal for an active effect into a local receipt', async () => {
    await expect(closeRetainedResponses(options, { read: async () => ({ digest: 'native', events: [publication('1')] }), close: async () => { throw new Error('Effect still active'); } })).rejects.toThrow('Effect still active');
  });
  it('rejects a changed close receipt instead of accepting a fabricated success', async () => {
    await expect(closeRetainedResponses(options, { read: async () => ({ digest: 'native', events: [publication('1')] }), close: async receipt => ({ ...receipt, validationJson: encode({ ...record(decode(receipt.validationJson)), text: 'changed' }) }) })).rejects.toMatchObject({ code: 'CORRELATION' });
  });
});

it.each(['{"$serde_json::private::Number":"1"}', '{"$serde_json::private::RawValue":"[true]"}', '{"$serde_json::private::Number":"not a number"}', '{"$serde_json::private::RawValue":"not JSON"}'])('keeps a valid JSON object with serde private-looking keys as published data: %s', async value => {
  const contractInterface = json('{"results":{"report":{"required":true,"mediaTypes":["application/json"],"valueSchema":{"type":"object"}}}}');
  const contractOptions = { ...options, interfaceJson: contractInterface, publicationContractJson: encode({ protocol: 'macro-agsdl-publication/1', registryVersion: context.registryVersion, agent: 'worker', step: ['work'], interface: decode(contractInterface), choices: [], decisionBinding: null }) };
  const result = await validateRetainedResponses(contractOptions, { digest: 'retained', events: [publication('1', `{"results":{"report":{"value":${value},"mediaType":"application/json"}}}`)] });
  expect(result.validation.kind).toBe('success');
  if (result.validation.kind !== 'success') throw new Error('Expected valid object publication');
  expect(record(record(decode(result.validation.resultsJson)).report).value).toEqual(decode(value));
});
