import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validatePortableHeader, renderPortableHeader, validatePortableMetadata, assertPortableUnicode, validatePortableArchive, portableManifestInput, portableLines, FRAME_BYTES, FRAGMENT_BYTES, vocabulary } from '../v2/portable-chat-history/validate.mjs';
const dir=new URL('../v2/portable-chat-history/',import.meta.url), utf8=s=>new TextEncoder().encode(s), digest=async b=>createHash('sha256').update(b).digest('hex');
const normative=['contract.md','frame.schema.json','schema-set.json','validate.d.mts','validate.mjs','vocabulary.json','../strict-json.mjs'];
const root={format:'portable-chat-history-1',resources:normative.sort().map(path=>({path,sha256:createHash('sha256').update(readFileSync(new URL(path,dir))).digest('hex')}))};
const rootBytes=JSON.stringify(root,null,2)+'\n', rootPath=new URL('portable-chat-history-contract.json',dir);
if(process.argv.includes('--generate'))writeFileSync(rootPath,rootBytes); else assert.equal(readFileSync(rootPath,'utf8'),rootBytes);
const contractSha=await digest(utf8(rootBytes));
const capture='a'.repeat(64),policy='fixture', metadata={version:1,normalizer:'macro-portable-history-1',policy,source:{ordinal:0,row:0,family:0,tag:0,sqlType:2},classification:'excluded_local_metadata',reason:'capture_provenance_only',captureManifest:capture,sourceLimits:vocabulary.sourceLimits,remainingLimits:vocabulary.remainingLimits};
const payloads=[utf8(JSON.stringify(metadata)),utf8(JSON.stringify({version:1,normalizer:'macro-portable-history-1',policy,source:{ordinal:1,row:1,family:1,tag:4,sqlType:2},classification:'retained_original',reason:'recognized_history',meaning:'message',message:'user',timestamp:'2026-01-01'})),utf8('\uFEFFhello é🙂')];
const headers=[];for(const [ordinal,bytes]of payloads.entries())headers.push({ordinal,entry:ordinal<2?{kind:'historical_text',purpose:'portable_metadata'}:{kind:'message',role:'user'},bytes:bytes.length,sha256:await digest(bytes),...(ordinal===2?{origin:1}:{})});
const descriptor={kind:'portable_archive',format:'portable-chat-history-1',content_contract_sha256:contractSha,records:3,bytes:payloads.reduce((n,b)=>n+b.length,0),manifest_sha256:await digest(portableManifestInput(capture,policy,headers))};
const frames=[descriptor,...headers.map((header,i)=>({header,offset:0,data:Buffer.from(payloads[i]).toString('base64')}))];
let used=0,peak=0,appends=0,inspections=0;
const ports={reserve(n){assert.ok(Number.isSafeInteger(n)&&n>=0); used+=n;peak=Math.max(peak,used);let live=true;return()=>{if(live){live=false;used-=n}}},digest,async inspect(){inspections++},async append(){appends++}};
async function run(values){async function* chunks(){for(const v of values){const b=utf8(JSON.stringify(v)+'\n');for(let i=0;i<b.length;i+=7)yield b.subarray(i,i+7)}}return validatePortableArchive(portableLines(chunks()),contractSha,ports)}
assert.deepEqual(await run(frames),{records:3,fragments:3,bytes:descriptor.bytes,manifest:descriptor.manifest_sha256});assert.equal(used,0);assert.equal(appends,3);assert.equal(inspections,3);
for(const mutate of [f=>f[0].content_contract_sha256='b'.repeat(64),f=>f[0].records++,f=>f[0].bytes++,f=>f[1].offset=1,f=>f[2].header.ordinal=7,f=>f[3].header.origin=null,f=>f[3].data='YQ==',f=>f.push(f[3]),f=>f[1].private='synthetic',f=>f[3].header.entry.role='system']) {const f=structuredClone(frames);mutate(f);await assert.rejects(run(f));assert.equal(used,0)}
for(const v of ['\uD800','\uDC00',{key:'\uD800'}, {'\uD800':'ok'}])assert.throws(()=>assertPortableUnicode(v),{message:'invalid_portable_unicode'});
for(const v of ['\uFEFF','é🙂','\uD800\uDC00'])assert.doesNotThrow(()=>assertPortableUnicode(v));
const args='{"integer":9007199254740993,"overflow":1e400}';assert.equal(new TextDecoder().decode(utf8(args)),args);
for(const m of [{...metadata,reason:'new_reason'},{...metadata,sourceHash:'b'.repeat(64)},{...metadata,source:{...metadata.source,tag:99}},{...metadata,classification:'retained_original',meaning:'data'},{...metadata,extra:1}])assert.throws(()=>validatePortableMetadata(m));
const max={ordinal:Number.MAX_SAFE_INTEGER,entry:{kind:'association',from:Number.MAX_SAFE_INTEGER,to:Number.MAX_SAFE_INTEGER,position:Number.MAX_SAFE_INTEGER,relation:'citation_for_message'},bytes:0,sha256:'f'.repeat(64)};
const maxHeader=renderPortableHeader(max);assert.ok(utf8(maxHeader).length<4096);
const upper= Math.max(...[max,{...headers[2],ordinal:Number.MAX_SAFE_INTEGER,origin:Number.MAX_SAFE_INTEGER,bytes:Number.MAX_SAFE_INTEGER}].map(header=>utf8(JSON.stringify({header,offset:Number.MAX_SAFE_INTEGER,data:'A'.repeat(4*Math.ceil(FRAGMENT_BYTES/3))})+'\n').length));
assert.ok(upper<FRAME_BYTES);assert.throws(()=>validatePortableHeader({...max,bytes:Number.MAX_SAFE_INTEGER+1}));
let loads=0;await assert.rejects(validatePortableArchive((async function*(){loads++;yield JSON.stringify(descriptor)+'\n'})(),contractSha,{...ports,reserve(){throw new Error('resource_limit')}}),{message:'resource_limit'});assert.equal(loads,0);
const fixturePath=new URL('../v2/portable-chat-history/fixtures.json',import.meta.url), fixtures=JSON.stringify({descriptor,headers,payloadBase64:payloads.map(b=>Buffer.from(b).toString('base64'))},null,2)+'\n';
// Root identity appears in descriptor; fixtures are non-normative conformance data.
if(process.argv.includes('--generate'))writeFileSync(fixturePath,fixtures);else assert.equal(readFileSync(fixturePath,'utf8'),fixtures);
assert.equal(used,0);console.log(JSON.stringify({contractSha,records:3,fragments:3,frameUpperBytes:upper,headerUpperBytes:utf8(maxHeader).length,logicalPeak:peak,fixtures:fileURLToPath(fixturePath)}));
