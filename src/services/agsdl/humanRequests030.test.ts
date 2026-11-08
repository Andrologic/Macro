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
