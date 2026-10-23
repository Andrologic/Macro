import { parseStoredJsonStrict } from '../strict-json.mjs';
import vocabulary from './vocabulary.json' with { type: 'json' };
export { vocabulary };
export const FRAGMENT_BYTES = 4093;
export const FRAME_BYTES = 8192;
const fail = code => { throw new Error(code); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const hash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys, required = keys) => {
  if (!object(v) || Object.keys(v).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail('invalid_portable_shape');
};
/** Reject before any UTF-8 derivation. Neither normalize nor replace code units. */
export function assertPortableUnicode(value) {
  const pending = [value];
  while (pending.length) {
    const entry = pending.pop();
    if (typeof entry === 'string') {
      for (let i = 0; i < entry.length; i++) {
        const c = entry.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = entry.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) fail('invalid_portable_unicode');
        } else if (c >= 0xdc00 && c <= 0xdfff) fail('invalid_portable_unicode');
      }
    } else if (entry && typeof entry === 'object') {
      for (const [key, nested] of Object.entries(entry)) { pending.push(key, nested); }
    }
  }
}
export function validatePortableHeader(value) {
  closed(value, ['ordinal', 'entry', 'bytes', 'sha256', 'origin'], ['ordinal', 'entry', 'bytes', 'sha256']);
  if (!integer(value.ordinal) || !integer(value.bytes) || !hash(value.sha256) || (Object.hasOwn(value, 'origin') && !integer(value.origin))) fail('invalid_portable_header');
  const e = value.entry;
  if (!object(e)) fail('invalid_portable_header');
  if (e.kind === 'message') { closed(e, ['kind', 'role']); if (!['user', 'assistant'].includes(e.role)) fail('invalid_portable_header'); }
  else if (e.kind === 'historical_text') { closed(e, ['kind', 'purpose']); if (!['portable_metadata', 'original_text', 'historical_data'].includes(e.purpose)) fail('invalid_portable_header'); }
  else if (e.kind === 'asset') { closed(e, ['kind', 'mime']); if (!Object.hasOwn(vocabulary.mime, e.mime)) fail('invalid_portable_header'); }
  else if (e.kind === 'citation') closed(e, ['kind']);
  else if (e.kind === 'association') {
    closed(e, ['kind', 'from', 'to', 'position', 'relation']);
    if (![e.from,e.to,e.position].every(integer) || !['data_for_message','asset_for_message','citation_for_message'].includes(e.relation) || value.bytes !== 0 || Object.hasOwn(value,'origin')) fail('invalid_portable_header');
  } else fail('invalid_portable_header');
  if (e.kind === 'historical_text' && e.purpose === 'portable_metadata') { if (Object.hasOwn(value, 'origin')) fail('invalid_portable_header'); }
  else if (e.kind !== 'association' && !Object.hasOwn(value, 'origin')) fail('invalid_portable_header');
  return value;
}
/** Stable field order is the existing TS normalizer order, not F canonical JSON. */
export function renderPortableHeader(input) {
  const h = validatePortableHeader(input), e = h.entry;
  const entry = e.kind === 'message' ? {kind:e.kind,role:e.role} : e.kind === 'historical_text' ? {kind:e.kind,purpose:e.purpose}
    : e.kind === 'asset' ? {kind:e.kind,mime:e.mime} : e.kind === 'association' ? {kind:e.kind,from:e.from,to:e.to,position:e.position,relation:e.relation} : {kind:e.kind};
  return JSON.stringify({ordinal:h.ordinal,entry,bytes:h.bytes,sha256:h.sha256,...(h.origin === undefined ? {} : {origin:h.origin})});
}
export function validatePortableMetadata(v) {
  closed(v,['version','normalizer','policy','source','classification','reason','meaning','message','timestamp','sourceHash','sourceBytes','captureManifest','retained','sourceLimits','remainingLimits'],['version','normalizer','policy','source','classification','reason']);
  assertPortableUnicode(v);
  if (v.version !== 1 || v.normalizer !== vocabulary.normalizer || typeof v.policy !== 'string' || !vocabulary.classifications.includes(v.classification) || !vocabulary.reasons[v.classification].includes(v.reason)) fail('invalid_portable_metadata');
  const s=v.source; closed(s,['ordinal','row','family','tag','sqlType','path'],['ordinal','row','family','tag','sqlType']);
  if (![s.ordinal,s.row,s.family,s.tag,s.sqlType].every(integer) || s.sqlType>3 || !vocabulary.families[s.family] || s.tag>=vocabulary.families[s.family].columns.length) fail('invalid_portable_metadata');
  if (s.path !== undefined && (!Array.isArray(s.path) || ![9,10].includes(s.tag) || s.family!==1 || s.path.some(p=>typeof p!=='string'&&!integer(p)))) fail('invalid_portable_metadata');
  if(s.path!==undefined) {
    const p=s.path;
    const valid=integer(p[0]) && (p.length===1 || (p.length===2&&['id','content','visible_content','reasoning_content','encrypted_content'].includes(p[1])) || (p.length===3&&p[1]==='tool_calls'&&integer(p[2])) || (p.length===4&&['content','summary'].includes(p[1])&&integer(p[2])&&['text','image_url'].includes(p[3])));
    if(!valid)fail('invalid_portable_metadata');
  }
  for (const k of ['message','timestamp']) if (v[k]!==undefined && typeof v[k]!=='string') fail('invalid_portable_metadata');
  for (const k of ['sourceHash','captureManifest']) if (v[k]!==undefined && !hash(v[k])) fail('invalid_portable_metadata');
  for (const k of ['retained','sourceBytes']) if (v[k]!==undefined && !integer(v[k])) fail('invalid_portable_metadata');
  if (v.meaning!==undefined && !vocabulary.meanings.includes(v.meaning)) fail('invalid_portable_metadata');
  for (const k of ['sourceLimits','remainingLimits']) if (v[k]!==undefined && (!Array.isArray(v[k]) || new Set(v[k]).size!==v[k].length || v[k].some(l=>![...vocabulary.sourceLimits,...vocabulary.remainingLimits].includes(l)))) fail('invalid_portable_metadata');
  if (v.classification==='excluded_local_metadata' && ['sourceHash','sourceBytes','meaning','retained','message','timestamp'].some(k=>v[k]!==undefined)) fail('invalid_portable_metadata');
  if (v.classification==='redundant_representation' && (!integer(v.retained)||v.meaning!==undefined)) fail('invalid_portable_metadata');
  if (v.classification==='retained_original' && (!vocabulary.meanings.includes(v.meaning)||v.retained!==undefined)) fail('invalid_portable_metadata');
  const at=(f,t)=>s.family===f && (Array.isArray(t)?t.includes(s.tag):s.tag===t);
  if (v.reason==='capture_provenance_only') {
    if (!at(0,0)||!hash(v.captureManifest)||!vocabulary.sourceLimits.every(l=>v.sourceLimits?.includes(l))||!vocabulary.remainingLimits.every(l=>v.remainingLimits?.includes(l))) fail('invalid_portable_metadata');
  } else if (['captureManifest','sourceLimits','remainingLimits'].some(k=>v[k]!==undefined)) fail('invalid_portable_metadata');
  if (['local_provider_continuation','opaque_continuation','local_identifier','provider_tool_call','inline_owned_image','recognized_identical_text','provider_final_matches_attributed_message','provider_display_matches_attributed_message'].includes(v.reason)&&!at(1,[9,10])) fail('invalid_portable_metadata');
  if (v.reason==='local_provider_continuation' && !at(1,10)) fail('invalid_portable_metadata');
  if (v.reason==='private_checkpoint_binding'&&!at(5,[8,20,21])) fail('invalid_portable_metadata');
  if (v.reason==='global_chat_scope'&&!at(0,3)) fail('invalid_portable_metadata');
  if (['complete_structured_hidden_representation','hidden_matches_complete_structured_results','recognized_hidden_only'].includes(v.reason)&&!at(1,8)) fail('invalid_portable_metadata');
  if (['owned_asset','identical_owned_asset'].includes(v.reason)&&!at(8,6)) fail('invalid_portable_metadata');
  if (v.reason==='sql_null' && s.sqlType!==0) fail('invalid_portable_metadata');
  const operational=[[0,7,8,9,10,11,12,13,14],[0,1,2,3,5,6,7,12,13],[0],[0,1,2,3,4],[0,1,2,3],[],[],[0,2,3],[0,1,5],[0,1,2,3,4,5,6]];
  if(v.reason==='local_operational_metadata'&&!operational[s.family].includes(s.tag))fail('invalid_portable_metadata');
  if(v.reason==='sql_null'&&!vocabulary.families[s.family].nullable.includes(vocabulary.families[s.family].columns[s.tag]))fail('invalid_portable_metadata');
  if(v.reason==='recognized_history') {
    const valid=at(0,[1,2])&&v.meaning==='original'||at(1,4)&&['original','message'].includes(v.meaning)||at(1,[9,10])&&['original','data','reflection'].includes(v.meaning)||at(1,11)&&v.meaning==='original'||at(2,1)&&v.meaning==='original'||s.family===5&&![8,20,21].includes(s.tag)&&v.meaning===(s.sqlType===1?'original':'checkpoint')||s.family===6&&v.meaning===(s.sqlType===1?'original':'citation')||at(7,1)&&v.meaning==='original'||at(8,[2,3,4])&&v.meaning==='original';
    if(!valid)fail('invalid_portable_metadata');
  }
  const meaning={provider_tool_call:'data',inline_owned_image:'asset',owned_asset:'asset',recognized_hidden_only:'data',complete_structured_hidden_representation:'original'}[v.reason];
  if(meaning&&v.meaning!==meaning)fail('invalid_portable_metadata');
  return v;
}
export function portableManifestInput(capture, policy, headers) {
  if (!hash(capture)||typeof policy!=='string') fail('invalid_portable_manifest');
  assertPortableUnicode(policy);
  return new TextEncoder().encode(JSON.stringify([capture,policy,headers.map(renderPortableHeader)]));
}
export function validatePortableDescriptor(v, contractSha) {
  closed(v,['kind','format','content_contract_sha256','records','bytes','manifest_sha256']);
  if(v.kind!=='portable_archive'||v.format!==vocabulary.format||!hash(contractSha)||v.content_contract_sha256!==contractSha||!integer(v.records)||v.records<1||!integer(v.bytes)||!hash(v.manifest_sha256)) fail('invalid_portable_descriptor');
  return v;
}
/** Admission belongs to the caller and precedes parsing/UTF-8 materialization. */
export function decodePortableFrame(raw) {
  if(typeof raw!=='string'||raw.length>FRAME_BYTES||!raw.endsWith('\n')||raw.startsWith('\uFEFF')) fail('invalid_portable_frame');
  assertPortableUnicode(raw);
  if(new TextEncoder().encode(raw).length>FRAME_BYTES) fail('invalid_portable_frame');
  return parseStoredJsonStrict(raw.slice(0,-1));
}
export async function* portableLines(chunks) {
  let line=new Uint8Array(FRAME_BYTES), used=0;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  for await (const chunk of chunks) for(const b of chunk) {
    if(used===FRAME_BYTES) fail('invalid_portable_frame');
    line[used++]=b;
    if(b===10) { try { yield decoder.decode(line.subarray(0,used)); } catch { fail('invalid_portable_frame'); } used=0; }
  }
  if(used) fail('invalid_portable_frame');
  line=null;
}
function unbase64(data) {
  if(typeof data!=='string'||data.length>4*Math.ceil(FRAGMENT_BYTES/3)||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) fail('invalid_portable_frame');
  let raw; try {raw=atob(data);}catch {fail('invalid_portable_frame');}
  if(btoa(raw)!==data||raw.length>FRAGMENT_BYTES) fail('invalid_portable_frame');
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
/** Pure content validation. Ports carry independently acquired admission and
 * policy; inspect must validate the known payload before any sink consumption.
 * No result of this function is a native authority, F pin or activation. */
export async function validatePortableArchive(lines, contractSha, ports) {
  if(!ports||typeof ports.reserve!=='function'||typeof ports.inspect!=='function'||typeof ports.digest!=='function'||typeof ports.append!=='function') fail('invalid_portable_ports');
  const held=[ports.reserve(FRAME_BYTES*256+1024)], headers=[], origins=new Map(), messages=new Map(), links=[];
  let descriptor, active, buffer, releaseRecord, position=0, total=0, fragments=0;
  const checkedDigest=async bytes=>{ const result=await ports.digest(bytes);if(!hash(result))fail('invalid_portable_ports');return result; };
  try {
    for await (const line of lines) {
      const value=decodePortableFrame(line);
      if(!descriptor) {descriptor=validatePortableDescriptor(value,contractSha);continue;}
      closed(value,['header','offset','data']); const h=validatePortableHeader(value.header);
      if(!integer(value.offset))fail('invalid_portable_frame');
      if(!active) {
        if(h.ordinal!==headers.length||value.offset!==0||h.ordinal>=descriptor.records)fail('invalid_portable_sequence');
        // Whole record inspection remains admitted O(record), not a heap claim.
        releaseRecord=ports.reserve(512+h.bytes*256); active=h; position=0;buffer=new Uint8Array(h.bytes);
      } else if(renderPortableHeader(h)!==renderPortableHeader(active))fail('invalid_portable_sequence');
      const bytes=unbase64(value.data);
      if(value.offset!==position||position+bytes.length>h.bytes||(!bytes.length&&(h.bytes!==0||position!==0)))fail('invalid_portable_sequence');
      buffer.set(bytes,position);position+=bytes.length;fragments++;
      if(!integer(fragments))fail('invalid_portable_sequence');
      if(position===h.bytes) {
        if(await checkedDigest(buffer)!==h.sha256)fail('invalid_portable_digest');
        const isMetadata=h.entry.kind==='historical_text'&&h.entry.purpose==='portable_metadata';
        let meta;
        if(isMetadata) {
          let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);}catch{fail('invalid_portable_unicode');}
          meta=validatePortableMetadata(parseStoredJsonStrict(text));
        }
        const origin=h.origin===undefined?undefined:origins.get(h.origin);
        if(h.origin!==undefined&&(!origin||origin.classification!=='retained_original'||h.origin>=h.ordinal))fail('invalid_portable_origin');
        if(meta?.classification==='redundant_representation'&&(!headers[meta.retained]||headers[meta.retained].entry.kind==='association'))fail('invalid_portable_origin');
        if(h.entry.kind==='message') {
          if(origin.meaning!=='message'||typeof origin.message!=='string'||!origin.message||typeof origin.timestamp!=='string'||messages.has(origin.message))fail('invalid_portable_origin');
          messages.set(origin.message,h.ordinal);
        }
        if(h.entry.kind==='association') {
          const e=h.entry, target=headers[e.to];
          if(headers[e.from]?.entry.kind!=='message'||!target||(e.relation==='asset_for_message'?target.entry.kind!=='asset':e.relation==='citation_for_message'?target.entry.kind!=='citation':target.entry.kind!=='historical_text'))fail('invalid_portable_association');
          links.push(e);
        }
        await ports.inspect(h,buffer,origin,meta);
        held.push(ports.reserve(1024+renderPortableHeader(h).length*8+(meta?buffer.length*256:0)));
        headers.push(h); if(meta)origins.set(h.ordinal,meta);
        total+=h.bytes;if(!integer(total)||total>descriptor.bytes)fail('invalid_portable_sequence');
        await ports.append(h,buffer); releaseRecord();releaseRecord=undefined;active=undefined;buffer=undefined;
      }
    }
    if(!descriptor||active||headers.length!==descriptor.records||total!==descriptor.bytes)fail('incomplete_portable_archive');
    const roots=[...origins.values()].filter(o=>o.reason==='capture_provenance_only');
    if(roots.length!==1||[...origins.values()].some(o=>o.policy!==roots[0].policy))fail('invalid_portable_origin');
    const associated=new Set(links.map(l=>`${l.from}:${l.to}`));
    for(const h of headers)if(h.origin!==undefined) {
      const o=origins.get(h.origin);
      if(o.message!==undefined&&h.entry.kind!=='message'&&!associated.has(`${messages.get(o.message)}:${h.ordinal}`))fail('invalid_portable_association');
    }
    for(const h of headers)if(h.entry.kind==='asset'&&!links.some(l=>l.to===h.ordinal&&l.relation==='asset_for_message'))fail('invalid_portable_association');
    held.push(ports.reserve(1024+headers.reduce((n,h)=>n+renderPortableHeader(h).length*24,0)+roots[0].policy.length*12));
    const manifestBytes=portableManifestInput(roots[0].captureManifest,roots[0].policy,headers);
    if(await checkedDigest(manifestBytes)!==descriptor.manifest_sha256)fail('invalid_portable_digest');
    return {records:headers.length,fragments,bytes:total,manifest:descriptor.manifest_sha256};
  } finally { releaseRecord?.(); for(const release of held.reverse())release(); }
}
