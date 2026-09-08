import { describe, expect, it } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import {
  validateContentMessage, validateContentResponse, validatePageContinuation,
  type ContentRequest, type ContentResponse,
} from './contentProtocol';

const directory = new URL('../../../contracts/macro-pilot/v2/fixtures/', import.meta.url);
const fixture = async <T = unknown>(name: string, group = 'valid'): Promise<T> =>
  JSON.parse(await readFile(new URL(`${group}/${name}.json`, directory), 'utf8')) as T;

describe('browser content protocol', () => {
  it('conforms to every public positive and negative fixture', async () => {
    for (const group of ['valid', 'invalid']) {
      for (const file of await readdir(new URL(`${group}/`, directory))) {
        expect(validateContentMessage(await fixture(file.slice(0, -5), group)), `${group}/${file}`).toBe(group === 'valid');
      }
    }
    for (const malformed of [null, undefined, [], {}, 'request', 42]) expect(validateContentMessage(malformed)).toBe(false);
  });

  it('correlates every operation and rejects all independently valid wrong operations', async () => {
    const operations = (await readdir(new URL('valid/', directory)))
      .filter(name => name.startsWith('request-') && name !== 'request-implement.json')
      .map(name => name.slice(8, -5));
    for (const operation of operations) {
      const request = await fixture<ContentRequest>(`request-${operation}`);
      const response = await fixture<ContentResponse>(`response-${operation}`);
      expect(validateContentResponse(request, response), operation).toBe(true);
      expect(validateContentResponse(request, { ...response, request_id: 'other-request' })).toBe(false);
      expect(validateContentResponse(request, { ...response, account_id: 'other-account' })).toBe(false);
      for (const other of operations.filter(value => value !== operation)) {
        expect(validateContentResponse(request, await fixture(`response-${other}`)), `${operation}/${other}`).toBe(false);
      }
    }
  });

  it('binds negotiation presence, selected version, event streams and errors', async () => {
    const negotiate = await fixture<Record<string, unknown>>('negotiate');
    const account = await fixture('account-negotiate');
    expect(validateContentResponse(negotiate, await fixture('negotiated'))).toBe(true);
    expect(validateContentResponse(negotiate, await fixture('negotiated-unsupported'))).toBe(true);
    expect(validateContentResponse({ ...negotiate, supported_versions: ['1.0'] }, await fixture('negotiated'))).toBe(false);
    expect(validateContentResponse(account, await fixture('account-negotiated'))).toBe(true);
    expect(validateContentResponse(account, await fixture('negotiated'))).toBe(false);
    expect(validateContentResponse(negotiate, await fixture('account-negotiated'))).toBe(false);
    const events = await fixture<Record<string, unknown>>('events-request');
    expect(validateContentResponse(events, await fixture('events-page'))).toBe(true);
    expect(validateContentResponse({ ...events, stream_id: 'other-stream' }, await fixture('events-page'))).toBe(false);
    expect(validateContentResponse({ ...events, stream_id: null }, await fixture('events-reset'))).toBe(true);
    expect(validateContentResponse(events, await fixture('error-events'))).toBe(true);
    expect(validateContentResponse(events, await fixture('error-unavailable'))).toBe(false);
  });

  it('checks diff snapshot, file, UTF-8 offsets and mutation revisions', async () => {
    const request = await fixture<ContentRequest<'diff.read'>>('request-diff.read');
    const response = await fixture<ContentResponse<'diff.read'>>('response-diff.read');
    for (const field of ['snapshot_id', 'file_id', 'offset_bytes']) {
      expect(validateContentResponse({ ...request, body: { ...request.body, [field]: field === 'offset_bytes' ? 1 : 'other-id' } }, response)).toBe(false);
    }
    response.result.patch = 'é'; response.result.total_bytes = 3; response.result.next_offset_bytes = 2;
    expect(validateContentMessage(response)).toBe(true);
    response.result.next_offset_bytes = 1;
    expect(validateContentMessage(response)).toBe(false);
    const mutation = await fixture<ContentResponse<'session.revoke'>>('response-session.revoke');
    mutation.result.revision++;
    expect(validateContentResponse(await fixture('request-session.revoke'), mutation)).toBe(false);
  });

  it('retains capture metadata, positions, cursor and all earlier identities', async () => {
    const first = await fixture<ContentResponse<'conversation.read'>>('response-conversation.read');
    first.result.page.total = 2; first.result.page.next_cursor = 'cursor-demo';
    const second = structuredClone(first);
    second.request_id = 'request-second'; second.result.page.offset = 1; second.result.page.next_cursor = null;
    second.result.items[0].position = 1; second.result.items[0].message_id = 'message-second';
    const request = await fixture<ContentRequest<'conversation.read'>>('request-conversation.read');
    request.request_id = second.request_id;
    request.body.continuation = { snapshot_id: first.result.page.snapshot_id, cursor: first.result.page.next_cursor };
    expect(validatePageContinuation(first, second, { request }).valid).toBe(true);
    for (const field of ['snapshot_id', 'revision', 'expires_at']) {
      const wrong = structuredClone(second);
      Object.assign(wrong.result.page, { [field]: field === 'revision' ? 2 : field === 'expires_at' ? '2026-01-01T00:04:00Z' : 'other-snapshot' });
      expect(validatePageContinuation(first, wrong).valid, field).toBe(false);
    }
    expect(validatePageContinuation(first, second, { request, seenIdentities: new Set(['message-second']) }).valid).toBe(false);
    request.body.continuation.cursor = 'wrong-cursor';
    expect(validatePageContinuation(first, second, { request }).valid).toBe(false);
    second.result.items[0].message_id = first.result.items[0].message_id;
    expect(validatePageContinuation(first, second).valid).toBe(false);
  });
});
