import { expect, it } from 'bun:test';
import { loadHumanRequests030, humanAnswer030, exactQuestionAnswer030, humanRequestView030 } from './humanRequests030';
import type { HumanScope030 } from '../../types/generated/ipc/HumanScope030';
import type { HumanPage030 } from '../../types/generated/ipc/HumanPage030';
import type { PublicHumanRequest030 } from '../../types/generated/ipc/PublicHumanRequest030';
const scope: HumanScope030 = { systemStartId: 'run', source: { owner: { projectId: 'p', planId: 'plan', branch: 'main' }, revision: '2', sourceSha256: 'a'.repeat(64) } };
const item = (id: string): PublicHumanRequest030 => ({ id, revision: '0', status: 'open', workIds: [], content: { kind: 'approval', title: 'T', description: 'D', message: 'M', choices: ['go'] } });
const first: HumanPage030 = { scope, cursor: '', total: '65', requests: Array.from({length:64}, (_, i) => item(String(i))), nextPage: { scope, cursor: '', offset: 64 } };
const last: HumanPage030 = { scope, cursor: '', total: '65', requests: [item('64')], nextPage: null };
it('assembles exact pages only after verifying continuation, scope, cursor and total', async () => {
  expect((await loadHumanRequests030(scope, async (_s, next) => next ? last : first, () => true))?.requests).toHaveLength(65);
  await expect(loadHumanRequests030(scope, async (_s, next) => next ? {...last, cursor: 'changed'} : first, () => true)).rejects.toThrow('Invalid');
  await expect(loadHumanRequests030(scope, async (_s, next) => next ? {...last, scope: {...scope, source: {...scope.source, revision: '3'}}} : first, () => true)).rejects.toThrow('Invalid');
  await expect(loadHumanRequests030(scope, async (_s, next) => next ? {...last, requests: [item('1')]} : first, () => true)).rejects.toThrow('Duplicate');
  await expect(loadHumanRequests030(scope, async (_s, next) => next ? Promise.reject({code:'CONFLICT'}) : first, () => true)).rejects.toMatchObject({code:'CONFLICT'});
});
it('discards a late page after switching run', async () => {
  let active = true;
  const result = await loadHumanRequests030(scope, async () => { active = false; return first; }, () => active);
  expect(result).toBeUndefined();
});
it('maps approval and plan without inventing a question format or changing exact JSON', () => {
  const request = item('x');
  expect(humanRequestView030(request, {plan:'Plan',question:'Question'})).toMatchObject({choices:[{value:'go',label:'go'}]});
  expect(humanAnswer030(request, {kind:'approval',choice:'go',comment:''})).toEqual({kind:'approval',choice:'go',comment:null});
  expect(() => humanAnswer030(request, {kind:'approval',choice:'other',comment:''})).toThrow();
  const question: PublicHumanRequest030 = {...request, content:{kind:'question',question:'Q',expectedResponse:'unknown'}};
  expect(() => humanAnswer030(question, {kind:'question',answer:'42'})).toThrow();
  const json = '{ "n": 900719925474099312345 }';
  expect(exactQuestionAnswer030(question, json)).toEqual({kind:'question',answerJson:json});
});

import { createHumanRequestClient030, humanRemainingMs030, humanDuration030, humanRequestKey030, runHumanAnswer030 } from './humanRequests030';
import { humanFixture030, humanTransportDouble030, memoryDraftStorage030, resolutionFixture030 } from '../../components/agsdl/HumanRequests030.test-fixtures';

it('uses exact monotone observations and never rounds a large integer through Number', () => {
  const clock = humanFixture030().clock;
  if (clock.kind !== 'available') throw new Error('fixture');
  expect(humanRemainingMs030(clock.value)).toBe('50000');
  expect(humanRemainingMs030({ ...clock.value, observedAtMs: '90071992547409990000' })).toBe('0');
  expect(humanRemainingMs030({ ...clock.value, timeoutMs: null })).toBeNull();
  expect(humanRemainingMs030({ ...clock.value, timeoutMs: '999999999999999999999' })).toBe('999999999999999989999');
  expect(humanDuration030('1')).toBe('0:01');
  expect(humanDuration030('115000')).toBe('1:55');
});
it('keeps all choices, comments and protocol bytes exact, and rejects mismatched answer kinds', () => {
  const request = humanFixture030();
  expect(runHumanAnswer030(request, { kind: 'approval', choice: 'refuser', comment: '' })).toEqual({ kind: 'approval', choice: 'refuser', comment: '' });
  expect(runHumanAnswer030({ ...request, content: { ...request.content, kind: 'flowChoice', title: '', description: '', messageJson: '{}', choices: [''] } }, { kind: 'approval', choice: '', comment: '  ' })).toEqual({ kind: 'approval', choice: '', comment: '  ' });
  const question = humanFixture030({ content: { kind: 'question', question: '?', expectedResponse: 'not a schema', answerContract: { kind: 'unavailable', gap: 'question-validator' } } });
  expect(() => runHumanAnswer030(question, { kind: 'question', answer: 'yes' })).toThrow();
  const qualified = { ...question, content: { kind: 'question' as const, question: '?', expectedResponse: '', answerContract: { kind: 'available' as const, value: { schemaJson: '{}', protocol: 'mcp/elicitation' } } } };
  const exact = ' { "large": 900719925474099312345, "escaped": "\\u0061" }\n';
  expect(runHumanAnswer030(qualified, { kind: 'question', answer: exact })).toEqual({ kind: 'question', answerJson: exact });
  expect(() => runHumanAnswer030(request, { kind: 'plan', approve: false, comment: '' })).toThrow();
  expect(() => runHumanAnswer030({ ...request, state: { kind: 'expired', resolution: resolutionFixture030({ reason: 'approvalTimeout', answer: null }) } }, { kind: 'approval', choice: 'refuser', comment: '' })).toThrow('REQUEST_CLOSED');
});
it('deduplicates in-flight and repeated submissions, including a new client after reload', async () => {
  const transport = humanTransportDouble030();
  const storage = memoryDraftStorage030();
  const client = createHumanRequestClient030({ ...transport, storage });
  const request = humanFixture030();
  const answer = { kind: 'approval' as const, choice: 'refuser', comment: '' };
  const first = client.send(request, answer);
  expect(client.send(request, answer)).toBe(first);
  expect((await first).current?.state.kind).toBe('submitted');
  await client.send(request, answer);
  await createHumanRequestClient030({ ...transport, storage }).send(request, answer);
  expect(transport.submissions).toHaveLength(1);
});
it('keeps a draft through revision conflict, navigation and reload without scope leakage', async () => {
  const transport = humanTransportDouble030(); transport.setMode('conflict');
  const storage = memoryDraftStorage030();
  const client = createHumanRequestClient030({ ...transport, storage });
  const request = humanFixture030();
  const draft = { choice: 'réviser', text: '  À conserver\nexactement. ' };
  client.saveDraft(request, draft);
  const result = await client.send(request, { kind: 'approval', choice: 'réviser', comment: draft.text });
  expect(result.result?.kind).toBe('refused');
  expect(result.current?.revision).toBe('1');
  expect(client.blocked(request)).toBe(false);
  expect(createHumanRequestClient030({ ...transport, storage }).loadDraft({ ...request, revision: '999' })).toEqual(draft);
  const otherScope = { ...request, scope: { ...request.scope, systemStartId: 'another-run' } };
  expect(client.loadDraft(otherScope)).toBeNull();
  expect(humanRequestKey030(otherScope)).not.toBe(humanRequestKey030(request));
});
it('never replays after lost acknowledgement or a failed read, even after reload', async () => {
  const transport = humanTransportDouble030(); transport.setMode('uncertain'); transport.failReads(true);
  const storage = memoryDraftStorage030();
  const request = humanFixture030(); const answer = { kind: 'approval' as const, choice: 'refuser', comment: '' };
  const client = createHumanRequestClient030({ ...transport, storage });
  expect(await client.send(request, answer)).toMatchObject({ result: { kind: 'uncertain' }, current: null, readFailed: true });
  const reloaded = createHumanRequestClient030({ ...transport, storage });
  await reloaded.send(request, answer);
  transport.failReads(false);
  await reloaded.refresh(request);
  await reloaded.send(request, answer);
  expect(transport.submissions).toHaveLength(1);
});
it('requires a successful correlated read before retrying a definitive refusal', async () => {
  const transport = humanTransportDouble030(); transport.setMode('conflict'); transport.failReads(true);
  const client = createHumanRequestClient030({ ...transport, storage: memoryDraftStorage030() });
  const request = humanFixture030(); const answer = { kind: 'approval' as const, choice: 'refuser', comment: '' };
  expect((await client.send(request, answer)).readFailed).toBe(true);
  expect(client.blocked(request)).toBe(true);
  transport.failReads(false);
  transport.setCurrent({ ...request, id: 'wrong-request' });
  await expect(client.refresh(request)).rejects.toThrow('CORRELATION');
  expect(client.blocked(request)).toBe(true);
  transport.setCurrent({ ...request, revision: '1' });
  await client.refresh(request);
  expect(client.blocked(request)).toBe(false);
});

it('retains request readback by run, capture and revision', async () => {
  const request = humanFixture030();
  const transport = humanTransportDouble030();
  const client = createHumanRequestClient030({ ...transport, storage: memoryDraftStorage030() });
  const latest = { ...request, revision: '2' };
  transport.setCurrent(latest);
  await client.refresh(request, 'capture-one');
  expect(client.currentRequest(request, 'capture-one')).toBe(latest);
  expect(client.currentRequest(request, 'capture-two')).toBe(request);
  const otherRun = { ...request, scope: { ...request.scope, systemStartId: 'other-run' } };
  expect(client.currentRequest(otherRun, 'capture-one')).toBe(otherRun);
  if (latest.clock.kind !== 'available') throw new Error('Expected a native clock');
  const clock = { ...latest.clock, value: { ...latest.clock.value, observedAtMs: (BigInt(latest.clock.value.observedAtMs) + 50000n).toString() } };
  expect(client.currentRequest({ ...latest, clock }, 'capture-one').clock).toEqual(clock);
  const newerProjection = { ...request, revision: '3' };
  expect(client.currentRequest(newerProjection, 'capture-one')).toBe(newerProjection);

  transport.setCurrent(request);
  await expect(client.refresh(request, 'capture-one')).rejects.toThrow('REVISION_CONFLICT');
  await client.send(request, { kind: 'approval', choice: 'refuser', comment: '' }, 'capture-one');
  expect(transport.submissions).toHaveLength(0);
  expect(client.currentRequest(request, 'capture-one')).toBe(latest);
});

it('does not submit if the local attempt cannot be retained', () => {
  const transport = humanTransportDouble030();
  const storage = memoryDraftStorage030();
  storage.setItem = () => { throw new Error('storage full'); };
  const client = createHumanRequestClient030({ ...transport, storage });
  expect(() => client.send(humanFixture030(), { kind: 'approval', choice: 'refuser', comment: '' })).toThrow('storage full');
  expect(transport.submissions).toHaveLength(0);
});

it('retains a received native answer when readback is older than its receipt', async () => {
  const request = humanFixture030();
  const transport = humanTransportDouble030(request);
  const client = createHumanRequestClient030({ submit: transport.submit, read: async () => request, storage: memoryDraftStorage030() });
  const result = await client.send(request, { kind: 'approval', choice: 'refuser', comment: '' });
  expect(result).toMatchObject({ current: { revision: '1', state: { kind: 'submitted' } }, readFailed: true });
  await expect(client.refresh({ ...request, revision: '2' })).rejects.toThrow('REVISION_CONFLICT');
});

for (const corrupted of ['[]', 'null', '42', '"corrompu"']) {
  it(`keeps a refused request locked when its stored draft becomes ${corrupted}`, async () => {
    const request = humanFixture030();
    const transport = humanTransportDouble030(request);
    const storage = memoryDraftStorage030();
    const submit = async (input: Parameters<typeof transport.submit>[0]) => {
      transport.submissions.push(input);
      return { kind: 'refused' as const, refusal: { code: 'REQUEST_CLOSED' as const, currentRevision: '2', message: 'Demande en révision 2.' } };
    };
    const answer = { kind: 'approval' as const, choice: 'réviser', comment: '' };
    await createHumanRequestClient030({ submit, read: transport.read, storage }).send(request, answer);
    const draftKey = `macro.human030.draft.${humanRequestKey030(request)}`;
    expect(storage.getItem(draftKey)).not.toBeNull();
    storage.setItem(draftKey, corrupted);
    const reloaded = createHumanRequestClient030({ submit, read: transport.read, storage });
    await expect(reloaded.refresh(request)).rejects.toThrow('Invalid retained draft');
    expect(reloaded.blocked(request)).toBe(true);
    await reloaded.send(request, answer);
    expect(transport.submissions).toHaveLength(1);
  });
}

for (const code of ['REQUEST_CLOSED', 'REVISION_CONFLICT'] as const) {
  it(`keeps the ${code} revision floor through stale reads, draft edits and a new client`, async () => {
    const request = humanFixture030();
    const transport = humanTransportDouble030(request);
    const storage = memoryDraftStorage030();
    const submit = async (input: Parameters<typeof transport.submit>[0]) => {
      transport.submissions.push(input);
      return { kind: 'refused' as const, refusal: { code, currentRevision: '2', message: 'Demande en révision 2.' } };
    };
    const client = createHumanRequestClient030({ submit, read: transport.read, storage });
    const answer = { kind: 'approval' as const, choice: 'réviser', comment: '  À conserver. ' };
    client.saveDraft(request, { choice: answer.choice, text: answer.comment });
    expect(await client.send(request, answer)).toMatchObject({ readFailed: true });
    expect(client.blocked(request)).toBe(true);
    await client.send(request, answer);
    expect(transport.submissions).toHaveLength(1);
    const reloaded = createHumanRequestClient030({ submit, read: transport.read, storage });
    expect(reloaded.loadDraft(request)).toEqual({ choice: answer.choice, text: answer.comment });
    reloaded.saveDraft(request, { choice: answer.choice, text: 'Brouillon modifié' });
    await expect(reloaded.refresh(request)).rejects.toThrow('REVISION_CONFLICT');
    await reloaded.send(request, answer);
    expect(transport.submissions).toHaveLength(1);
    transport.setCurrent({ ...request, revision: '1' });
    await expect(reloaded.refresh(request)).rejects.toThrow('REVISION_CONFLICT');
    transport.setCurrent({ ...request, revision: '2' });
    const current = await reloaded.refresh(request);
    expect(reloaded.blocked(current)).toBe(false);
    expect(reloaded.loadDraft(current)?.text).toBe('Brouillon modifié');
  });
}
