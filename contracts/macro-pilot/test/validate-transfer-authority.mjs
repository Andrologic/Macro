import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as authority from '../v2/transfer-authority/validate.mjs';

let cases=0;
const check=(actual,expected,label)=>{assert.equal(actual,expected,label);assert.equal(authority.diagnosticsEmpty(),true,label+' diagnostics');cases++;};
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const now=Date.parse('2026-10-23T12:00:00.000Z');
const request=(kind='controller',target='target')=>({authority_contract:authority.VERSION,type:'preflight',request_id:uuid(1),scope:kind==='producer'?{kind,instance_id:'source'}:{kind,source_instance_id:'source',target_instance_id:target}});
const producer=instance=>({account_id:'account',instance_id:instance,generation:'generation',connection_id:uuid(instance==='source'?2:3),state:'active'});
const actor=()=>({account_id:'account',session_id:'session',device_id:'device',session_revision:'1',account_epoch:'0',source_access_revision:'1',target_access_revision:'1'});
const snapshot=req=>({authority_contract:authority.VERSION,type:'authority_snapshot',request_id:req.request_id,scope:structuredClone(req.scope),authority_origin:'https://relay.example',issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+29000).toISOString(),...(req.scope.kind==='producer'?{producer:producer(req.scope.instance_id)}:{actor:actor(),source_producer:producer(req.scope.source_instance_id),target_producer:req.scope.target_instance_id===null?null:producer(req.scope.target_instance_id),recovery_generation:uuid(4),history:'intact'})});
const expected=()=>({request_id_header:uuid(1),response_request_id_header:uuid(1),account_id:'account',expected_origin:'https://relay.example',connection_origin:'https://relay.example'});
const time=()=>({now_ms:now,dispatch_age_ms:1000});
const receive=(q,s,e=expected(),t=time())=>authority.validateResponse(q,s,e,t).valid;
const error=code=>({authority_contract:authority.VERSION,type:'authority_error',request_id:uuid(1),code,retryable:['unavailable','instance_offline'].includes(code)});
const variants=[request(),request('controller',null),request('producer')];
for(const req of variants) {
  const s=snapshot(req);
  check(authority.validateRequest(req,req.request_id).valid,true,'request '+JSON.stringify(req.scope));
  check(authority.validateObject(s).valid,true,'shape');check(receive(req,s),true,'receive');
  for(const code of ['validation_failed','unsupported_version','unauthorized','session_revoked','forbidden','authority_changed','producer_changed','instance_offline','recovery_hold','resource_limit','unavailable']) {
    check(receive(req,error(code)),true,code);const e=error(code);e.retryable=!e.retryable;check(authority.validateObject(e).valid,false,'retryability');
  }
  for(const type of ['committed','aborted','snapshot']){const e=error('unavailable');e.type=type;check(authority.validateObject(e).valid,false,'no terminal');}
  for(const [label,mutate] of [
    ['scope',x=>x.scope.kind==='producer'?x.scope.instance_id='other':x.scope.source_instance_id='other'],
    ['request',x=>x.request_id=uuid(5)],['origin',x=>x.authority_origin='https://other.example'],
    ['http',x=>x.authority_origin='http://127.0.0.1:8080'],['path origin',x=>x.authority_origin+='/' ],
    ['invalid calendar',x=>x.issued_at='2026-02-30T12:00:00.000Z'],
    ['leap calendar',x=>x.issued_at='2025-02-29T12:00:00.000Z'],
    ['bad month',x=>x.issued_at='2026-13-01T12:00:00.000Z'],
    ['bad hour',x=>x.issued_at='2026-10-23T24:00:00.000Z'],
    ['bad ms length',x=>x.issued_at='2026-10-23T12:00:00Z'],
    ['offset',x=>x.issued_at='2026-10-23T12:00:00.000+00:00'],
    ['31 seconds',x=>x.expires_at=new Date(now+30000).toISOString()],
    ['zero duration',x=>x.expires_at=x.issued_at],
    ['reverse duration',x=>x.expires_at=new Date(now-2000).toISOString()],
    ['account',x=>(x.producer??x.actor).account_id='other'],
    ['instance',x=>(x.producer??x.source_producer).instance_id='other'],
    ['inactive',x=>(x.producer??x.source_producer).state='inactive'],
    ['extra',x=>x.authenticated=true],
    ['nested extra',x=>(x.producer??x.actor).private_synthetic_extra='synthetic'],
  ]) {const broken=structuredClone(s);mutate(broken);check(receive(req,broken),false,label);}
  for(const field of Object.keys(expected())){const e=expected();delete e[field];check(receive(req,s,e),false,'missing expected '+field);check(receive(req,error('unavailable'),e),false,'error missing expected '+field);}
  for(const field of Object.keys(expected())){const e=expected();e[field]=field.includes('origin')?'https://elsewhere.example':'other';check(receive(req,s,e),false,'wrong expected '+field);}
  for(const t of [undefined,{}, {now_ms:now}, {dispatch_age_ms:1000}, {now_ms:NaN,dispatch_age_ms:0}, {now_ms:now-1001,dispatch_age_ms:0}, {now_ms:now+29000,dispatch_age_ms:0}, {now_ms:now,dispatch_age_ms:30000}, {now_ms:now,dispatch_age_ms:-1}, {now_ms:now,dispatch_age_ms:Infinity}, {now_ms:now,dispatch_age_ms:NaN}])check(authority.validateResponse(req,s,expected(),t).valid,false,'missing/expired/clock');
  // The body is fresh on the wall clock, but cannot reset independent age.
  const short=structuredClone(s);short.issued_at=new Date(now-100).toISOString();short.expires_at=new Date(now+100).toISOString();
  check(receive(req,short,expected(),{now_ms:now,dispatch_age_ms:200}),false,'independent monotone TTL');
  check(receive(req,short,expected(),{now_ms:now,dispatch_age_ms:199.5}),true,'bounded fractional monotone age');
  const restored=structuredClone(s);if('history' in restored)restored.history='restored';check(receive(req,restored),true,'restore is facts only');
}
const q=request(),s=snapshot(q);
// Rejection at every nested object must empty all generated AJV error slots.
for(const req of variants) {
  const value=snapshot(req);
  function nested(object) {
    if(!object||typeof object!=='object')return;
    object.private_synthetic_unknown='synthetic';
    check(authority.validateObject(value).valid,false,'nested diagnostics');
    delete object.private_synthetic_unknown;
    for(const child of Object.values(object))nested(child);
  }
  nested(value);
}
for(const [key,value] of [['target_producer',null],['recovery_generation','not-a-uuid']]){const x=structuredClone(s);x[key]=value;check(authority.validateObject(x).valid,false,key);}
for(const field of ['account_id','instance_id','generation']){const x=structuredClone(s);x.target_producer[field]='other';check(authority.validateObject(x).valid,field==='generation','target '+field);}
const sourceOnly=request('controller',null),solo=snapshot(sourceOnly);
for(const mutate of [x=>x.target_producer=producer('target'),x=>x.actor.target_access_revision='2']){const x=structuredClone(solo);mutate(x);check(authority.validateObject(x).valid,false,'source only');}
const equal=request('controller','source');check(authority.validateObject(equal).valid,false,'same participant');
const different=request('producer');check(receive(different,s),false,'variant mismatch');
for(const field of ['session_revision','account_epoch','source_access_revision','target_access_revision']) {
  for(const value of ['-1','01','+1','1.0',' 1','9223372036854775808','99999999999999999999',1,null,'1\n']){const x=structuredClone(s);x.actor[field]=value;check(authority.validateObject(x).valid,false,'i64 '+field);}
  const x=structuredClone(s);x.actor[field]='9223372036854775807';check(authority.validateObject(x).valid,true,'i64 max');
  x.actor[field]='0';check(authority.validateObject(x).valid,field==='account_epoch','positive i64');
}
for(const value of ['', 'x'.repeat(129), 'é', 'x\n', 'x\u0000']){const x=structuredClone(s);x.actor.session_id=value;check(authority.validateObject(x).valid,false,'id');}
for(const value of ['not-uuid',uuid(2).toUpperCase()+'x',uuid(2)+'\n']){const x=structuredClone(q);x.request_id=value;check(authority.validateObject(x).valid,false,'uuid');}
check(authority.matchesRoute('POST',authority.ROUTE),true,'route');
for(const [method,path] of [['GET',authority.ROUTE],['POST',authority.ROUTE+'/'],['POST',authority.ROUTE+'?x=1'],['POST','/pilot/v2/transfers/preflight']])check(authority.matchesRoute(method,path),false,'closed route');
check(authority.validateRequest(q,uuid(2)).valid,false,'request header');
for(const x of [Object.assign(Object.create({inherited:true}),q),Object.defineProperty(structuredClone(q),'scope',{get(){throw Error('synthetic');},enumerable:true}),Object.assign(structuredClone(q),{[Symbol('synthetic')]:true})])check(authority.validateObject(x).valid,false,'plain data');

let reservations=0,releases=0,live=0,loaded=0,consumed=0,units=0;
const ports=()=>({charges:{working:17,copies:23},reserve(n){reservations++;live++;units=n;return ()=>{live--;releases++;};}});
for(const req of variants) {
  const p=ports();const out=await authority.withRequest(()=>{assert.equal(live,1);loaded++;return JSON.stringify(req);},p,req.request_id,x=>{assert.equal(live,1);assert.deepEqual(x,req);consumed++;});check(out.valid,true,'withRequest');
  check(units,authority.admissionUnits('request',p.charges),'request admission');
  const out2=await authority.withResponse(async()=>{loaded++;return new TextEncoder().encode(JSON.stringify(snapshot(req)));},p,req,expected(),()=>{assert.equal(live,1);return time();},x=>{assert.equal(live,1);assert.equal(x.type,'authority_snapshot');consumed++;});check(out2.valid,true,'withResponse');
  check(units,authority.admissionUnits('response',p.charges),'response admission');
}
const load=()=>{loaded++;return JSON.stringify(q);};
let before=loaded;
check((await authority.withDecoded('request',load,{charges:{working:0,copies:0},reserve(){throw Error('quota');}},()=>{})).valid,false,'admission before loader');check(loaded,before,'not loaded');
for(const badPorts of [{reserve(){throw Error('must not call');}},{charges:{working:-1,copies:0},reserve(){throw Error('must not call');}},{charges:{working:0,copies:0},reserve(){return null;}},{charges:{working:Number.MAX_SAFE_INTEGER,copies:1},reserve(){throw Error('must not call');}}])check((await authority.withDecoded('request',load,badPorts,()=>{})).valid,false,'bad port');
check(loaded,before,'invalid ports never load');
check(authority.admissionUnits('request',{working:0,copies:0}),1146880,'request inventory');
check(authority.admissionUnits('response',{working:0,copies:0}),2293760,'response inventory');
// A pending asynchronous consumer must keep the whole decoding lease alive.
let finish,entered;
const gate=new Promise(resolve=>{finish=resolve;});
const started=new Promise(resolve=>{entered=resolve;});
const pending=authority.withDecoded('request',()=>JSON.stringify(q),ports(),async()=>{entered();await gate;assert.equal(live,1);});
await started;check(live,1,'lease held across consumer await');finish();check((await pending).valid,true,'deferred consumer');check(live,0,'deferred release');
const raw=JSON.stringify(q);
const badRaw=['[]','null','true','123','{}',raw.replace('"type":"preflight"','"type":"preflight","type":"preflight"'),raw.replace('"type":"preflight"','"type":"preflight","t\\u0079pe":"preflight"'),'\uFEFF'+raw,raw+'x','{"__proto__":'+raw+'}',raw.replace('"source"','"\\ud800"'),raw.replace('"source"','"\\udc00"'),new Uint8Array([0xef,0xbb,0xbf,...new TextEncoder().encode(raw)]),new Uint8Array([0xc0,0xaf]),new Uint8Array([0xed,0xa0,0x80]),new Uint8Array([0xf0,0x28,0x8c,0xbc]),new Uint8Array(4097),raw+' '.repeat(4096),{...q}];
for(const input of badRaw){const consumedBefore=consumed;check((await authority.withDecoded('request',()=>input,ports(),()=>{consumed++;})).valid,false,'hostile decode');check(consumed,consumedBefore,'not consumed');check(live,0,'released');}
for(const len of [4096,4097]){check((await authority.withDecoded('request',()=>raw+' '.repeat(len-Buffer.byteLength(raw)),ports(),()=>{})).valid,len===4096,'raw request limit');}
const responseRaw=JSON.stringify(s);
for(const len of [8192,8193])check((await authority.withDecoded('response',()=>responseRaw+' '.repeat(len-Buffer.byteLength(responseRaw)),ports(),()=>{})).valid,len===8192,'raw response limit');
for(const [loader,consumer] of [[()=>{throw Error('load');},()=>{}],[async()=>{throw Error('async load');},()=>{}],[()=>raw,()=>{throw Error('consume');}],[()=>raw,async()=>{throw Error('async consume');}]]){check((await authority.withDecoded('request',loader,ports(),consumer)).valid,false,'exception cleanup');check(live,0,'released on exception');}
check((await authority.withDecoded('request',()=>raw,{charges:{working:0,copies:0},reserve(){return ()=>{throw Error('release');};}},()=>{})).valid,false,'throwing release');
for(const readTime of [undefined,()=>{throw Error('clock');},()=>({now_ms:now,dispatch_age_ms:30000})])check((await authority.withResponse(()=>responseRaw,ports(),q,expected(),readTime,()=>{throw Error('must not consume');})).valid,false,'freshness after I/O');
let age=0;
check((await authority.withResponse(async()=>{age=30000;return responseRaw;},ports(),q,expected(),()=>({now_ms:now,dispatch_age_ms:age}),()=>{throw Error('must not consume');})).valid,false,'clock read after awaited loader');
check(live,0,'all leases released');check(reservations,releases,'balanced reservations');

// Dependency identities and the future relay import manifest cover actual bytes.
const directory=new URL('../v2/transfer-authority/',import.meta.url);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of ['transfer-authority-contract.json']) {
  const manifest=JSON.parse(readFileSync(new URL(file,directory),'utf8'));
  check(manifest.status,'contract_only_no_runtime_authority','inactive manifest');
  for(const resource of manifest.resources)check(sha(readFileSync(new URL(resource.path,directory))),resource.sha256,'manifest '+resource.path);
}
check(sha(readFileSync(new URL('schema.json',directory))),authority.IDENTITIES.schema_sha256,'schema identity');
for(const resource of authority.IDENTITIES.dependencies)check(sha(readFileSync(new URL(resource.path,directory))),resource.sha256,'dependency '+resource.path);
check(sha(JSON.stringify(authority.IDENTITIES.dependencies)),authority.IDENTITIES.dependency_set_sha256,'dependency set');
console.log(JSON.stringify({authorityCases:cases,loaded,consumed,reservations,releases,diagnosticsEmpty:authority.diagnosticsEmpty()}));
