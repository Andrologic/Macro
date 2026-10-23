import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as browser from '../v2/transfer-transit/decision-browser.generated.mjs';
const directory = new URL('../v2/', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, directory), 'utf8'));
let cases = 0;
for (const kind of ['valid', 'invalid']) for (const file of readdirSync(new URL(`fixtures/transfer-decision/${kind}/`, directory))) {
  const value = read(`fixtures/transfer-decision/${kind}/${file}`);
  assert.equal(browser.validateObject(value).valid, kind === 'valid', file);
  assert.equal(browser.diagnosticsEmpty(), true); cases++;
}
for (const value of [{z:'é🙂\0', a:['é', '\ud83d\ude00']}, {b:'\\\"\n',a:128}]) {
  assert.equal(typeof browser.fingerprint('source-key', value), 'string'); cases++;
}
// Rejected nested property names and throwing getters must leave no input in
// any generated Ajv error slot, including sub-validators.
const binding = read('fixtures/transfer-decision/valid/request-reserve.json');
function checkNested(value) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    value.private_synthetic_unknown = 'synthetic-only';
    assert.equal(browser.validateObject(binding).valid, false);
    assert.equal(browser.diagnosticsEmpty(), true); cases++;
    delete value.private_synthetic_unknown;
  }
  for (const child of Object.values(value)) checkNested(child);
}
checkNested(binding);
Object.defineProperty(binding.body, 'binding', {get(){throw Error('synthetic-only');}, configurable:true});
assert.equal(browser.validateObject(binding).valid, false);
assert.equal(browser.diagnosticsEmpty(), true); cases++;
if (!process.argv.includes('--csp')) {
  const original = await import('../v2/transfer-decision-validate.mjs');
  const {scenario} = await import('./transfer-decision-vectors.mjs');
  for (const max of [false,true]) {
    const s = scenario(max);
    for (const stage of ['birth','reserve','seal','ready','commit','activate']) {
      const x=s[stage], prior=stage==='birth'?null:stage==='reserve'?s.birth:stage==='seal'?s.reserve:stage==='ready'?s.seal:stage==='commit'?s.ready:s.commit;
      assert.deepEqual(browser.planDecision(x.request,prior?.result.ledger??null,prior?.result.record??null,x.context),x.result);
      assert.deepEqual(browser.validateExchange(x.request,x.result,stage==='birth'?undefined:s.expectation(x.request.operation)),original.validateExchange(x.request,x.result,stage==='birth'?undefined:s.expectation(x.request.operation)));
      const broken=structuredClone(x.result);if(broken.receipt)broken.receipt.receipt_id=s.uuid();
      assert.deepEqual(browser.validateExchange(x.request,broken,stage==='birth'?undefined:s.expectation(x.request.operation)),original.validateExchange(x.request,broken,stage==='birth'?undefined:s.expectation(x.request.operation)));cases+=3;
    }
  }
  for (const value of [{z:'é🙂\0',a:['é','\ud83d\ude00']},{b:'\\\"\n',a:128}]) for (const domain of ['source-key','transfer-binding','retry-body','attestation']) {
    assert.equal(browser.fingerprint(domain,value),original.fingerprint(domain,value));cases++;
  }
  // Execute the actual audited relational/reception matrices against the same
  // browser factory, changing only module import URLs in an in-memory copy.
  for (const name of ['reception-matrix','terminal-matrix','invariant-boundaries']) {
    const url=new URL(`transfer-decision-${name}.mjs`,import.meta.url);
    let source=readFileSync(url,'utf8');
    source=source.replaceAll("'../v2/transfer-decision-validate.mjs'",JSON.stringify(new URL('../v2/transfer-transit/decision-browser.generated.mjs',import.meta.url).href));
    source=source.replaceAll("'./transfer-decision-vectors.mjs'",JSON.stringify(new URL('./transfer-decision-vectors.mjs',import.meta.url).href));
    const modified=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const baseline=await import(url.href);
    const key=Object.keys(modified)[0];assert.deepEqual(modified[key](),baseline[key]());cases++;
  }
}
console.log(JSON.stringify({browserDecisionCases:cases,csp:process.argv.includes('--csp'),diagnosticsEmpty:browser.diagnosticsEmpty()}));
