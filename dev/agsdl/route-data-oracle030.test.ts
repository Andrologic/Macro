import { expect, it } from 'bun:test';
import { evaluateRouteData030 } from './route-data-oracle030';
import { buildRouteDataCorpus030 } from './route-data-corpus030';
it('retains both failure layers and exact lexical call outputs', async () => {
  const input = { operation:'normalize',prepared:{kind:'command',parse:'json'},receipt:{stdout:'1E+2',output:'both',exitCodeJson:'1.0',complete:true} };
  const evaluate = (op:string,i:unknown) => evaluateRouteData030({op,json:JSON.stringify(i)});
  const normalized = JSON.parse(await evaluate('callData',input));
  expect(JSON.parse(normalized.json)).toBe('{"kind":"completed","outputJson":"{\\"outcome\\":\\"failed\\",\\"data\\":{\\"exitCode\\":1.0,\\"output\\":\\"both\\",\\"value\\":1E+2}}"}');
  const bad = {...input,receipt:{...input.receipt,stdout:'{'}};
  expect(JSON.parse(JSON.parse(await evaluate('callData',bad)).json)).toBe('{"kind":"failed","code":"OUTPUT_INVALID"}');
  const job={ticket:'ticket',generation:'generation',inputDigest:'digest',inputJson:JSON.stringify(bad)};
  expect(JSON.parse(JSON.parse(await evaluate('broker',{job})).json)).toEqual({kind:'ready',resultJson:'{"kind":"failed","code":"OUTPUT_INVALID"}'});
  expect(JSON.parse(await evaluate('broker',{job:{...job,generation:'retired'}}))).toEqual({status:'exception',name:'Error',message:'Route mailbox generation changed.'});
});
it('keeps a deterministic distinct corpus with measured family coverage and all pinned files', async () => {
  const first=await buildRouteDataCorpus030(),second=await buildRouteDataCorpus030();
  expect(first).toEqual(second);
  expect(first.files).toHaveLength(37);
  expect(new Set(first.cases.map(c=>JSON.stringify(c.request))).size).toBe(first.cases.length);
  for (const [family,min] of Object.entries(first.minimums)) expect(first.cases.filter(c=>c.family===family).length).toBeGreaterThanOrEqual(min);
});
