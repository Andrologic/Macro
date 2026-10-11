import { expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { validateContentMessage, validateContentResponse } from './contentProtocol';
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../../contracts/macro-pilot/v2/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
it('keeps legacy sessions exact and permits activity only on the opt-in projection', async () => {
  const req = await fixture('request-sessions.list'); const res = await fixture('response-sessions.list');
  expect(validateContentResponse(req, res)).toBe(true);
  res.result.items[0].last_seen_at = '2026-10-10T12:00:00.000Z';
  expect(validateContentResponse(req, res)).toBe(false);
  req.body.include_last_seen = true; expect(validateContentResponse(req, res)).toBe(true);
  req.body.include_last_seen = false; expect(validateContentResponse(req, res)).toBe(false);
});
it('requires machine capability attestation and rejects incorrect instances/projects or memory bounds', async () => {
  for (const op of ['instance.telemetry', 'project.icon']) {
    const req = await fixture(`request-${op}`); const res = await fixture(`response-${op}`);
    const delivery = await fixture(`${op}-delivery`);
    expect(validateContentMessage(delivery)).toBe(true);
    delivery.capabilities = []; expect(validateContentMessage(delivery)).toBe(false);
    expect(validateContentResponse(req, res)).toBe(true);
    if (op === 'instance.telemetry') { res.result.memory_used_bytes = res.result.memory_total_bytes + 1; expect(validateContentMessage(res)).toBe(false); res.result.memory_used_bytes = 0; res.result.instance_id = 'other'; }
    else res.result.ref.project_id = 'other';
    expect(validateContentResponse(req, res)).toBe(false);
  }
});
