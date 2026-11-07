import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LIMITS,admissionUnits} from '../v2/transfer-authority/validate.mjs';
const directory=new URL('../v2/',import.meta.url);
const decision=JSON.parse(readFileSync(new URL('transfer-decision.schema.json',directory),'utf8'));
const authority=JSON.parse(readFileSync(new URL('transfer-authority/schema.json',directory),'utf8'));
const wire=value=>Buffer.byteLength(JSON.stringify(value));
const asciiDefs=new Set(['id','uuid','decimal','positive']);
function maximum(s,root,name) {
  if(s.$ref){const [base,key]=s.$ref.split('#/$defs/');const owner=base?decision:root;return maximum(owner.$defs[key],owner,key);}
  if(s.allOf) {
    // activeProducer intersects the canonical producer with a fixed state.
    assert.equal(name,'activeProducer');
    const producer=structuredClone(decision.$defs.producer);
    assert.deepEqual(s.allOf[1],{type:'object',properties:{state:{const:'active'}}});
    assert.equal(s.allOf[0].$ref,decision.$id+'#/$defs/producer');
    Object.assign(producer.properties,s.allOf[1].properties);return maximum(producer,decision);
  }
  if('const' in s)return wire(s.const);
  if(s.enum)return Math.max(...s.enum.map(wire));
  if(s.oneOf)return Math.max(...s.oneOf.map(x=>maximum(x,root)));
  if(s.type==='null')return 4;
  if(s.type==='boolean')return 5;
  if(s.type==='string') {
    assert.ok(Number.isSafeInteger(s.maxLength));
    const ascii=root===decision&&asciiDefs.has(name)||root===authority&&name==='date';
    return 2+s.maxLength*(ascii?1:6);
  }
  if(s.type==='object') {
    assert.equal(s.additionalProperties,false);
    const entries=Object.entries(s.properties);
    assert.deepEqual([...s.required].sort(),entries.map(([key])=>key).sort());
    return 2+Math.max(entries.length-1,0)+entries.reduce((n,[key,child])=>n+wire(key)+1+maximum(child,root),0);
  }
  throw Error('Review unbounded authority schema');
}
const bounds={};
for(const name of ['request','controllerSnapshot','producerSnapshot','error'])bounds[name]=maximum(authority.$defs[name],authority,name);
assert.equal(bounds.request,450);
assert.equal(bounds.controllerSnapshot,3836);
assert.ok(bounds.producerSnapshot<bounds.controllerSnapshot);
assert.ok(bounds.error<bounds.controllerSnapshot);
assert.ok(bounds.request<=LIMITS.request);
assert.ok(Math.max(bounds.controllerSnapshot,bounds.producerSnapshot,bounds.error)<=LIMITS.response);
assert.equal(admissionUnits('request',{working:0,copies:0}),4096*256+4096*16+4096*8);
assert.equal(admissionUnits('response',{working:0,copies:0}),8192*256+8192*16+8192*8);
console.log(JSON.stringify({bounds,limits:{request:LIMITS.request,response:LIMITS.response},logicalAdmission:{request:admissionUnits('request',{working:0,copies:0}),response:admissionUnits('response',{working:0,copies:0})}}));
