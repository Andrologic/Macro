import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { validateContentMessage, validateContentResponse, validateContentIntegrity, validateContentFileBytes } from './contentProtocol';
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../../contracts/macro-pilot/v2/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
test('requires each independent file capability and opaque authority without extending old deliveries', async () => {
  for (const op of ['attachment.begin', 'conversation.send.attachments', 'conversation.files.list']) {
    const delivery = await fixture(`files-delivery-${op}`); expect(validateContentMessage(delivery)).toBe(true);
    const capability = delivery.capabilities[0];
    delivery.capabilities = ['conversations-1']; expect(validateContentMessage(delivery)).toBe(false);
    delivery.capabilities = [capability]; delete delivery.authority_binding; expect(validateContentMessage(delivery)).toBe(false);
  }
  const old = await fixture('project.icon-delivery'); expect(validateContentMessage(old)).toBe(true);
  old.authority_binding = 'authority-demo'; expect(validateContentMessage(old)).toBe(false);
});
test('correlates immutable intents, complete refs, transfers, selected files and offsets', async () => {
  for (const op of ['attachment.begin', 'attachment.chunk', 'attachment.finalize', 'conversation.send.attachments', 'conversation.send.status', 'conversation.file.capture', 'conversation.file.read']) {
    const req = await fixture(`request-${op}`), res = await fixture(`response-${op}`); expect(validateContentResponse(req, res)).toBe(true);
    const wrong = structuredClone(res); wrong.result.ref.conversation_id = 'different-demo'; expect(validateContentResponse(req, wrong)).toBe(false);
    for (const key of ['intent_id', 'transfer_id', 'file_id', 'snapshot_id', 'offset_bytes']) if (key in req.body) {
      const next = structuredClone(res); next.result[key] = key === 'offset_bytes' ? 1 : 'different-demo'; expect(validateContentResponse(req, next)).toBe(false);
    }
    if (op === 'conversation.send.attachments') { res.result.attachment_ids = ['different-demo']; expect(validateContentResponse(req, res)).toBe(false); }
  }
});
test('verifies chunk and assembled-file digests independently of shape validity', async () => {
  const req = await fixture('request-attachment.chunk'); expect(await validateContentIntegrity(req)).toBe(true);
  req.body.sha256 = '0'.repeat(64); expect(validateContentMessage(req)).toBe(true); expect(await validateContentIntegrity(req)).toBe(false);
  const cap = (await fixture('response-conversation.file.capture')).result;
  expect(await validateContentFileBytes(cap, new TextEncoder().encode('hello\n'))).toBe(true);
  expect(await validateContentFileBytes(cap, new TextEncoder().encode('false\n'))).toBe(false);
});
test('rejects oversized raw fragments, invalid cursors and absent file bytes disguised as available', async () => {
  const req = await fixture('request-attachment.chunk'); req.body.data_base64 = btoa('x'.repeat(65537)); expect(validateContentMessage(req)).toBe(false);
  const res = await fixture('response-conversation.file.read'); res.result.next_offset_bytes = 1; expect(validateContentMessage(res)).toBe(false);
  const cap = await fixture('response-conversation.file.capture'); cap.result.mime_type = null; expect(validateContentMessage(cap)).toBe(false);
  cap.result.content_state = 'withheld'; cap.result.sha256 = null; cap.result.total_bytes = null; expect(validateContentMessage(cap)).toBe(true);
});
