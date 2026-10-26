import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as v from '../v2/transfer-transit/validate.mjs';
import {sha256Bytes} from '../v2/transfer-transit/decision-browser.generated.mjs';
const vectors=JSON.parse(readFileSync(new URL('../v2/transfer-transit/vectors.json',import.meta.url),'utf8'));
const {session,empty,first,second,full,proof,producer,decisionRequest,challenge,exchange,reply,expectation,text}=vectors.context;
const clone=structuredClone,enc=new TextEncoder(),bytes=x=>enc.encode(x),json=x=>bytes(JSON.stringify(x));
let assertions=0;
const yes=(a,b=true)=>{assert.equal(a,b);assertions++;};
const message=(type)=>clone(vectors.valid.find(m=>m.type===type));
let active=0,loads=0,callbacks=0,admissions=0;
const ports={reserve:n=>{yes(n,v.LIMITS.admission);active++;admissions++;let live=true;return()=>{yes(live,true);live=false;active--;};}};
for(const m of vectors.valid) {
 yes(v.validateObject(m).valid);yes(v.diagnosticsEmpty());
 const result=await v.withDecoded(()=>{loads++;yes(active,1);return json(m);},ports,decoded=>{callbacks++;yes(active,1);assert.deepEqual(decoded,m);assertions++;});yes(result.valid);yes(active,0);
 for(const key of Object.keys(m)){const bad=clone(m);delete bad[key];yes(v.validateObject(bad).valid,false);}
 const extra={...m,private_unknown:'synthetic'};yes(v.validateObject(extra).valid,false);yes(v.diagnosticsEmpty());
}
const deferred=clone(vectors.valid.find(m=>m.type==='producer.delivery'&&m.body.kind==='transit.chunk'));let releaseCallback;const gate=new Promise(resolve=>{releaseCallback=resolve;});let entered;const inCallback=new Promise(resolve=>{entered=resolve;});const pending=v.withDecoded(()=>json(deferred),ports,async()=>{entered();await gate;yes(active,1);});await inCallback;yes(active,1);releaseCallback();yes((await pending).valid);yes(active,0);
const goodRaw=JSON.stringify(first);const ambiguous=goodRaw.slice(0,-1)+',"request_\\u0069d":'+JSON.stringify(first.request_id)+'}';yes(v.validateObject(JSON.parse(ambiguous)).valid);let ambiguousCalled=false;yes((await v.withDecoded(()=>bytes(ambiguous),ports,()=>{ambiguousCalled=true;})).valid,false);yes(ambiguousCalled,false);
const replacement=clone(first);Object.assign(replacement,{data_utf8:'\ufffd',length:'3',sha256:sha256Bytes(bytes('\ufffd'))});const correct=json(replacement);const at=correct.findIndex((x,i)=>x===239&&correct[i+1]===191&&correct[i+2]===189);yes(at>=0);const lossy=new Uint8Array(correct.length-2);lossy.set(correct.subarray(0,at));lossy[at]=195;lossy.set(correct.subarray(at+3),at+1);yes(v.validateObject(JSON.parse(new TextDecoder().decode(lossy))).valid);yes((await v.withDecoded(()=>lossy,ports,()=>{throw Error('must not consume');})).valid,false);
const before=loads;yes((await v.withDecoded(()=>{loads++;return json(first);},{reserve:()=>{throw Error('synthetic');}},()=>{callbacks++;})).valid,false);yes(loads,before);yes(active,0);
const malformed=[new Uint8Array([0xc3,0x28]),new Uint8Array([0xef,0xbb,0xbf,...json(first)]),bytes('{"type":"x","t\\u0079pe":"x"}'),bytes('{"x":"\\ud800"}'),bytes('[]'),bytes('null'),new Uint8Array(98305)];
for(const raw of malformed){let called=false;yes((await v.withDecoded(()=>raw,ports,()=>{called=true;})).valid,false);yes(called,false);yes(active,0);yes(v.diagnosticsEmpty());}
yes((await v.withDecoded(()=>json(first),ports,()=>{throw Error('private synthetic');})).valid,false);yes(active,0);
for(const c of ['','01','-1','+1','1e3','1.0','9223372036854775808',1])for(const field of ['sequence','offset','length']){const m=clone(first);m[field]=c;yes(v.validateObject(m).valid,false);}
for(const mutate of [m=>m.sha256='0'.repeat(64),m=>m.data_utf8+='x',m=>m.length='1',m=>m.data_utf8='\ud800',m=>m.data_utf8='x'.repeat(65537)]){const m=clone(first);mutate(m);yes(v.validateObject(m).valid,false);}
for(const t of ['\ufeff exact\n','a'.repeat(65536),'\0'.repeat(20000),'\n'.repeat(65536),'é'.repeat(32769),'🙂'.repeat(17000),'\\"\t\r'.repeat(17000)]) {
 const size=v.utf8JsonSize(t);yes(size.bytes,bytes(t).length);yes(size.json,bytes(JSON.stringify(t)).length);
 const prefix=v.blockPrefix(t),raw=t.slice(0,prefix.units);yes(prefix.bytes<=65536);yes(prefix.json<=94208);yes(bytes(raw).length,prefix.bytes);yes(bytes(JSON.stringify(raw)).length,prefix.json);v.assertUnicode(raw);assertions++;
 if(prefix.units<t.length){const next=String.fromCodePoint(t.codePointAt(prefix.units));const size=v.utf8JsonSize(raw+next);yes(size.bytes>65536||size.json>94208);}
}
for(const t of ['\ud800','\udc00','x\ud800z'])assert.throws(()=>v.blockPrefix(t));
for(const c of ['x','\\','\n','\0','🙂']) {const m=clone(first);Object.assign(m,{data_utf8:c,length:String(bytes(c).length),sha256:sha256Bytes(bytes(c))});yes(v.validateObject(m).valid);const tagged={...m,data_utf8:c+'x'};yes(v.validateObject(tagged).valid,false);}
const deliveryThrow=message('producer.delivery');Object.defineProperty(deliveryThrow.body,'exchange',{get(){throw Error('private synthetic');},configurable:true});yes(v.validateObject(deliveryThrow).valid,false);yes(v.diagnosticsEmpty());
// Exact i64 cursors retain digits beyond Number.MAX_SAFE_INTEGER.
let cursor=clone(empty);let plan=v.inspectChunk(first,session,cursor);yes(plan.valid);yes(plan.kind,'append');assert.deepEqual(cursor,empty);cursor=plan.cursor;
yes(v.inspectChunk(first,session,cursor).kind,'retry');plan=v.inspectChunk(second,session,cursor);yes(plan.valid);assert.deepEqual(plan.cursor,full);yes(v.inspectChunk(second,session,full).kind,'retry');
for(const mutate of [m=>m.offset='1',m=>m.sequence='2',m=>m.eof=true,m=>m.transit_id='ffffffff-ffff-ffff-ffff-ffffffffffff',m=>m.transfer_id='ffffffff-ffff-ffff-ffff-ffffffffffff']){const m=clone(first);mutate(m);yes(v.inspectChunk(m,session,empty).valid,false);}
yes(v.inspectChunk(first,session,full).valid,false);let stages=0;yes((await v.withChunk(()=>json(first),ports,session,empty,()=>{stages++;yes(active,1);})).valid);yes(stages,1);for(const bad of [{...first,offset:'1'},{...first,eof:true},{...first,sha256:'f'.repeat(64)}])yes((await v.withChunk(()=>json(bad),ports,session,empty,()=>{stages++;})).valid,false);yes(stages,1);assert.deepEqual(empty,vectors.context.empty);
const big=clone(session);big.stream_bytes='9007199254740995';const one=clone(first);Object.assign(one,{data_utf8:'xy',length:'2',offset:'9007199254740993',sequence:'9007199254740993',sha256:sha256Bytes(bytes('xy')),eof:true});const prior={next_sequence:one.sequence,next_offset:one.offset,eof:false,last:{sequence:'9007199254740992',offset:'9007199254740992',length:'1',sha256:'a'.repeat(64),eof:false}};const high=v.inspectChunk(one,big,prior);yes(high.valid);yes(high.cursor.next_offset,'9007199254740995');yes(high.cursor.next_sequence,'9007199254740994');
const ack=message('transit.ack');yes(v.validateAck(ack,second,session,ack.request_id).valid);
for(const key of ['request_id','sequence','offset','length','sha256','next_offset','transfer_id','transit_id']) {const a=clone(ack);a[key]=key==='sha256'?'f'.repeat(64):'0';yes(v.validateAck(a,second,session,ack.request_id).valid,false);}
yes(v.validateSession(message('transit.opened'),session).valid);yes(v.validateSession(message('transit.opened'),{...session,stream_bytes:'900'}).valid,false);yes(v.validateProgress(message('transit.progress'),session,message('transit.progress').request_id).valid);
// Every public F presentation is checked by the original F reception rules.
yes(v.validateDecisionReply(decisionRequest,reply,expectation).valid);yes(v.validateDecisionReply(decisionRequest,{...reply,request_id:'other'},expectation).valid,false);
const wrong=clone(reply);wrong.result.receipt.subject_digest='a'.repeat(64);yes(v.validateDecisionReply(decisionRequest,wrong,expectation).valid,false);
const arbitrary=clone(reply);arbitrary.result={valid:true,kind:'mutation',ledger:{},record:{},receipt:null,reservation_bytes:'0',errors:[]};yes(v.validateObject(arbitrary).valid,false);
yes(v.validateChallengeReply(challenge,exchange,proof.exchange).valid);yes(v.validateChallengeReply(challenge,{...exchange,exchange:{...exchange.exchange,subject_digest:'a'.repeat(64)}},proof.exchange).valid,false);
yes(v.validateObject({...challenge,kind:'lineage_created'}).valid,false);
const received=message('proof.received');yes(v.validateReceived(received,proof.exchange,received.request_id).valid);yes(v.validateReceived(received,{...proof.exchange,challenge_id:'ffffffff-ffff-ffff-ffff-ffffffffffff'},received.request_id).valid,false);
yes(v.validateProofResult(message('proof.result'),proof.exchange,producer,producer.connection_id).valid);yes(v.validateProofResult(message('proof.result'),proof.exchange,producer,'ffffffff-ffff-ffff-ffff-ffffffffffff').valid,false);
for(const key of Object.keys(proof.exchange)){const a=clone(message('proof.result'));const attKey={instance_id:'producer_instance_id',connection_id:null}[key]??key;if(key==='connection_id')continue;a.attestation[attKey]=null;yes(v.validateProofResult(a,proof.exchange,producer,producer.connection_id).valid,false);}
// Read source S and both participants BEFORE body, including reserve before T exists.
const b=decisionRequest.request.body.binding,source=b.provenance.source,root='/pilot/v2/transfers/';
const reserve=root+`sources/${source.source_instance_id}/${source.source_conversation_id}/targets/${b.target_instance_id}/reservations/${b.transfer_id}/decisions`;
yes(v.validateRoute(v.parseRoute('POST',reserve),decisionRequest).valid);
yes(v.validateRoute(v.parseRoute('POST',reserve.replace(source.source_conversation_id,'other')),decisionRequest).valid,false);
yes(v.validateRoute(v.parseRoute('POST',root+`known/${b.transfer_id}/challenges`),challenge).valid);
yes(v.validateRoute(v.parseRoute('POST',root+`known/${b.transfer_id}/transit`),message('transit.open')).valid);
for(const m of [first,ack,message('transit.status'),message('transit.close')]){const action=m.type.slice(8);yes(v.validateRoute(v.parseRoute('POST',root+`transits/${session.transit_id}/${action}`),m).valid);}
for(const bad of [reserve+'/',reserve+'?x=1',reserve.replace('source-synthetic','source%2Dsynthetic'),'/pilot/v2/transfers/known/notuuid/decisions'])yes(v.parseRoute('POST',bad),null);
yes(v.parseRoute('GET',reserve),null);const sourceRequest=clone(decisionRequest);sourceRequest.request=JSON.parse(readFileSync(new URL('../v2/fixtures/transfer-decision/valid/request-lineage.create.json',import.meta.url),'utf8'));yes(v.validateRoute(v.parseRoute('POST',root+`sources/${source.source_instance_id}/${source.source_conversation_id}/decisions`),sourceRequest).valid);yes(v.validateRoute(v.parseRoute('POST',root+`sources/${source.source_instance_id}/other/decisions`),sourceRequest).valid,false);yes(v.validateRoute(v.parseRoute('POST',root+`sources/${source.source_instance_id}/${source.source_conversation_id}/decisions`),decisionRequest).valid,false);
// Header selection precedes body decoding; invalid offers never read payload.
const d=message('producer.delivery'),ctx={offered:v.VERSION,confirmed:v.VERSION,response_status:200,poll_request_id:d.request_id,response_request_id:d.request_id,instance_id:d.instance_id,producer_generation:d.producer_generation,connection_id:d.connection_id};
const deliveryPorts={...ports,withContent:async()=>{throw Error('Unexpected v2 branch');},validateContent:()=>false};
let got=[];yes((await v.withProducerDelivery(()=>Promise.resolve(json(d)),deliveryPorts,ctx,r=>{got.push(r.branch);})).valid);assert.deepEqual(got,['transit']);
yes((await v.withProducerDelivery(()=>Promise.resolve(json(d)),deliveryPorts,{...ctx,producer_generation:null,connection_id:null},()=>{})).valid);
for(const context of [{...ctx,offered:undefined},{...ctx,offered:v.VERSION+', '+v.VERSION},{...ctx,offered:'other'},{...ctx,confirmed:v.VERSION+', '+v.VERSION},{...ctx,confirmed:'other'},{...ctx,producer_generation:'old-generation'},{...ctx,connection_id:'ffffffff-ffff-ffff-ffff-ffffffffffff'},{...ctx,response_request_id:'wrong'}]){let consumed=false;yes((await v.withProducerDelivery(()=>Promise.resolve(json(d)),deliveryPorts,context,()=>{consumed=true;})).valid,false);yes(consumed,false);}
let untouched=0;yes((await v.withProducerDelivery(()=>{untouched++;throw Error();},deliveryPorts,{...ctx,confirmed:null,response_status:204},r=>{yes(r.branch,'empty');})).valid);yes(untouched,0);yes((await v.withProducerDelivery(()=>{untouched++;throw Error();},deliveryPorts,{...ctx,response_status:204},()=>{})).valid,false);yes(untouched,0);
// v2 grammar stays at its true owner. No second v2 schema inside this contract.
if(!process.argv.includes('--csp')) {
 const canonical=await import('../v2/validate.mjs');
 const frontend=await import('../../../src/services/macroPilot/contentValidators.generated.js');
 const content=JSON.parse(readFileSync(new URL('../v2/fixtures/valid/delivery.json',import.meta.url),'utf8'));
 const p={...ports,withContent:async(load,consume)=>consume(JSON.parse(new TextDecoder().decode(await load()))),validateContent:m=>canonical.validateMessage(m).valid};
 yes(frontend.validateMessage(content).valid,canonical.validateMessage(content).valid);for(const mutate of [m=>m.extra='x',m=>m.transport_version='1.0',m=>m.request.body.extra='x']){const m=clone(content);mutate(m);yes(frontend.validateMessage(m).valid,canonical.validateMessage(m).valid);yes(frontend.validateMessage(m).valid,false);}
 const contentCtx={...ctx,confirmed:null,instance_id:content.instance_id,response_request_id:content.request_id};got=[];
 for(const context of [{...contentCtx,offered:undefined},contentCtx])yes((await v.withProducerDelivery(()=>Promise.resolve(json(content)),p,context,r=>{got.push(r.branch);})).valid);
 assert.deepEqual(got,['content','content']);const catches={...p,withContent:async(load,consume)=>{try{await consume(JSON.parse(new TextDecoder().decode(await load())));return {valid:true};}catch{return {valid:false};}}};yes((await v.withProducerDelivery(()=>Promise.resolve(json(content)),catches,contentCtx,()=>{throw Error('synthetic consumer refusal');})).valid,false);yes((await v.withProducerDelivery(()=>Promise.resolve(json(content)),{...catches,validateContent:()=>false},contentCtx,()=>{throw Error('must not consume');})).valid,false);yes((await v.withProducerDelivery(()=>Promise.resolve(json(content)),catches,contentCtx,()=>{})).valid);
 yes((await v.withProducerDelivery(()=>Promise.resolve(json(d)),p,{...ctx,confirmed:null},()=>{})).valid,false);
 yes((await v.withProducerDelivery(()=>Promise.resolve(json(content)),p,{...contentCtx,confirmed:v.VERSION},()=>{})).valid,false);
 yes((await v.withProducerDelivery(()=>Promise.resolve(json(d)),deliveryPorts,ctx,()=>{})).valid); // F, content, then F keep one poll contract.
}
const maxChunk=clone(first);const raw='x'.repeat(65536);Object.assign(maxChunk,{data_utf8:raw,length:'65536',sha256:sha256Bytes(bytes(raw))});yes(v.validateObject(maxChunk).valid);const wrapped=clone(vectors.valid.find(m=>m.type==='producer.delivery'&&m.body.kind==='transit.chunk'));wrapped.body.message=maxChunk;yes(v.validateObject(wrapped).valid);yes(json(wrapped).length<=98304);
yes(first.data_utf8+second.data_utf8,text);yes(active,0);yes(v.diagnosticsEmpty());
// Coordination is closed bounded data; only later native/F proofs authorize.
const invitation=message('transit.invitation'),proposal=message('transit.prepared');
for(const type of ['transit.open','transit.invitation'])for(const [field,value] of [['provider_id',''],['provider_id','bad provider'],['provider_id','x'.repeat(129)],['model_id',''],['model_id','x'.repeat(257)]]){const m=message(type);m[field]=value;yes(v.validateObject(m).valid,false);}
yes(v.validateRoute(v.parseRoute('POST',`/pilot/v2/transfers/transits/${proposal.transit_id}/prepared`),proposal).valid);
yes(v.validateRoute(v.parseRoute('POST',`/pilot/v2/transfers/transits/${proposal.transit_id}/prepared`),invitation).valid,false);
for(const mutate of [m=>m.binding.transfer_id='ffffffff-ffff-4fff-8fff-ffffffffffff',m=>m.session.binding_digest='f'.repeat(64),m=>m.session.manifest_digest='f'.repeat(64),m=>m.manifest.source_revision='900',m=>m.authority=true]){const m=clone(invitation);mutate(m);yes(v.validateObject(m).valid,false);}
for(const mutate of [m=>m.prepared.authority=true,m=>m.prepared.prepared_ts={},m=>m.extra='forbidden']){const m=clone(proposal);mutate(m);yes(v.validateObject(m).valid,false);}
const targetInvitation=clone(vectors.valid.find(m=>m.type==='producer.delivery'&&m.body.kind==='transit.invitation'));
for(const key of ['instance_id','producer_generation']){const m=clone(targetInvitation);m[key]='wrong';yes(v.validateObject(m).valid,false);}
const oversized=clone(invitation);oversized.binding.provenance.source.relay_origin='https://'+('x'.repeat(2000))+'.invalid';yes(v.validateObject(oversized).valid,false);
console.log(JSON.stringify({transitAssertions:assertions,admissions,loads,callbacks,active,csp:process.argv.includes('--csp')}));
