import { message as shape, session as sessionShape, cursor as cursorShape, clearErrors, diagnosticsEmpty as shapeDiagnosticsEmpty } from './shape.generated.mjs';
import * as decision from './decision-browser.generated.mjs';
import { parseStoredJsonStrict } from '../strict-json.mjs';
import { IDENTITIES } from './identities.generated.mjs';
export { IDENTITIES };
export const LIMITS = Object.freeze({raw:65536,dataJson:94208,body:98304,controls:4096,graph:25165824,working:1048576,copies:2097152,admission:28311552});
export const OFFER_HEADER = 'X-Macro-Transfer-Transit';
export const VERSION = 'transfer-transit-1';
const encoder=new TextEncoder();
const fail=(code='validation_failed')=>{throw new Error(code);};
const requireThat=(test,code)=>{if(!test)fail(code);};
const valid=()=>({valid:true});
const invalid=()=>({valid:false,code:'validation_failed'});
const same=(a,b)=>decision.canonicalJson(a)===decision.canonicalJson(b);
const exact=decision.exactInteger;
const add=decision.addBytes;
const F=(v,d)=>requireThat(decision.validateObject(v,d).valid);
export function assertUnicode(text) {
  requireThat(typeof text==='string');
  for(let i=0;i<text.length;i++) {
    const c=text.charCodeAt(i);
    if(c>=0xd800&&c<=0xdbff){const n=text.charCodeAt(++i);requireThat(n>=0xdc00&&n<=0xdfff);}
    else requireThat(!(c>=0xdc00&&c<=0xdfff));
  }
}
/** A size counter only. JSON.parse/stringify remain the syntax owners. */
function scalarCost(c) {
  const bytes=c<=0x7f?1:c<=0x7ff?2:c<=0xffff?3:4;
  const json=c===34||c===92||[8,9,10,12,13].includes(c)?2:c<32?6:bytes;
  return {bytes,json};
}
export function utf8JsonSize(text) {
  assertUnicode(text);let bytes=0,json=2;
  for(const scalar of text){const cost=scalarCost(scalar.codePointAt(0));bytes+=cost.bytes;json+=cost.json;}
  return {bytes,json};
}
/** Operate only on an already admitted current producer buffer, never history. */
export function blockPrefix(text) {
  requireThat(typeof text==='string');let bytes=0,json=2,units=0;
  for(const scalar of text){assertUnicode(scalar);const cost=scalarCost(scalar.codePointAt(0));if(bytes+cost.bytes>LIMITS.raw||json+cost.json>LIMITS.dataJson)break;bytes+=cost.bytes;json+=cost.json;units+=scalar.length;}
  return {units,bytes,json};
}
function chunkRules(m) {
  const size=utf8JsonSize(m.data_utf8);
  requireThat(size.bytes>0&&size.bytes<=LIMITS.raw&&size.json<=LIMITS.dataJson,'resource_limit');
  requireThat(exact(m.length)===BigInt(size.bytes));
  requireThat(decision.sha256Bytes(encoder.encode(m.data_utf8))===m.sha256);
  add(m.offset,m.length);decision.increment(m.sequence);
}
function sessionRules(s) {
  try{requireThat(sessionShape(s)===true);}finally{clearErrors();}
  for(const key of ['portable_records','portable_fragments','portable_payload_bytes','stream_bytes'])exact(s[key]);
  requireThat(s.content_contract_sha256===IDENTITIES.content_contract_sha256,'unsupported_context');
  requireThat(exact(s.portable_fragments)>=exact(s.portable_records));
}
function cursorRules(c) {
  try{requireThat(cursorShape(c)===true);}finally{clearErrors();}
  exact(c.next_sequence);exact(c.next_offset);
  if(c.last===null)requireThat(c.next_sequence==='0'&&c.next_offset==='0'&&!c.eof);
  else {
    for(const key of ['sequence','offset','length'])exact(c.last[key]);
    requireThat(exact(c.last.length)>0n&&exact(c.last.length)<=BigInt(LIMITS.raw));
    requireThat(c.next_sequence===decision.increment(c.last.sequence)&&c.next_offset===add(c.last.offset,c.last.length)&&c.eof===c.last.eof);
  }
}
function challengeKinds(request) {
  const op=request.operation;
  return op==='lineage.create'?[request.body.mode==='created'?'lineage_created':'lineage_enrolled']:op==='reserve'||op==='reconcile'&&request.body.action==='abort_missing'?['source_frozen']:op==='seal'?['source_sealed']:op==='ready'?['target_pinned']:op==='commit'?['source_maintained','target_maintained']:op==='activation.record'?['target_activated']:[];
}
function proofDelivery(m) {
  const e=m.body.exchange,request=m.body.request;
  requireThat(m.delivery_id===e.delivery_id&&m.instance_id===e.instance_id&&m.producer_generation===e.producer_generation&&m.connection_id===e.connection_id);
  F(request,'request');F(e,'exchange');
  requireThat(e.request_digest===decision.fingerprint('retry-body',request)&&challengeKinds(request).includes(e.kind));
  const full=request.body.binding??request.body.provenance;
  if(full)requireThat(e.binding_digest===decision.fingerprint(request.body.binding?'transfer-binding':'provenance',full));
}
function rules(m) {
  switch(m.type) {
    case 'transit.open':case 'transit.opened':sessionRules(m.session);if(m.cursor){cursorRules(m.cursor);requireThat(exact(m.cursor.next_offset)<=exact(m.session.stream_bytes)&&m.cursor.eof===(m.cursor.next_offset===m.session.stream_bytes));}break;
    case 'transit.chunk':chunkRules(m);break;
    case 'transit.ack':for(const k of ['sequence','offset','length','next_offset'])exact(m[k]);requireThat(exact(m.length)>0n&&exact(m.length)<=BigInt(LIMITS.raw)&&m.next_offset===add(m.offset,m.length));decision.increment(m.sequence);break;
    case 'transit.pull':exact(m.sequence);exact(m.offset);break;
    case 'transit.progress':cursorRules(m.cursor);break;
    case 'decision.request':F(m.request,'request');break;
    case 'decision.challenge':F(m.request,'request');F(m.kind,'attestationKind');requireThat(challengeKinds(m.request).includes(m.kind));break;
    case 'decision.exchange':case 'proof.received':F(m.exchange,'exchange');break;
    case 'proof.result':F(m.attestation,'attestation');break;
    case 'decision.reply': {
      const r=m.result;
      if(r.kind==='error')F(r.error,'error');
      else if(['retry','terminal'].includes(r.kind)){F(r.receipt);if(r.status)F(r.status,'status');}
      else F(r.status,r.kind==='source_status'?'sourceStatus':'status');break;
    }
    case 'producer.delivery':
      if(m.body.kind==='proof.challenge')proofDelivery(m);
      else {requireThat(m.body.message.request_id===m.request_id);rules(m.body.message);}
      break;
    case 'error':requireThat(m.retryable===['unavailable','instance_offline'].includes(m.code));break;
  }
}
/** Plain-data API. The host owns admission before input construction. */
export function validateObject(m) {
  try {
    try {requireThat(shape(m)===true);}finally{clearErrors();}
    rules(m);
    const rendered=decision.canonicalJson(m),body=encoder.encode(rendered).length;
    requireThat(body<=LIMITS.body,'resource_limit');
    const chunk=m.type==='transit.chunk'?m:m.type==='producer.delivery'&&m.body.kind==='transit.chunk'?m.body.message:null;
    if(chunk) {const empty=structuredClone(m);if(empty.type==='transit.chunk')empty.data_utf8='';else empty.body.message.data_utf8='';requireThat(encoder.encode(decision.canonicalJson(empty)).length-2<=LIMITS.controls,'resource_limit');}
    return valid();
  }catch{return invalid();}finally{clearErrors();}
}
/** Load happens only after full conservative admission. The callback's views
 * must not escape; a retaining host acquires its own charge before retention. */
export async function withDecoded(load,ports,consume) {
  let release,result=invalid();
  try {
    requireThat(typeof load==='function'&&typeof ports?.reserve==='function'&&typeof consume==='function');
    release=ports.reserve(LIMITS.admission);requireThat(typeof release==='function','resource_limit');
    const input=await load();let raw;
    if(typeof input==='string'){requireThat(input.length<=LIMITS.body,'resource_limit');assertUnicode(input);requireThat(encoder.encode(input).length<=LIMITS.body,'resource_limit');raw=input;}
    else {requireThat(input instanceof Uint8Array&&input.length<=LIMITS.body,'resource_limit');raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}
    const m=parseStoredJsonStrict(raw);requireThat(validateObject(m).valid);await consume(m);result=valid();
  }catch{result=invalid();}finally{clearErrors();if(typeof release==='function'){try{release();}catch{result=invalid();}}}
  return result;
}
export const diagnosticsEmpty=()=>shapeDiagnosticsEmpty()&&decision.diagnosticsEmpty();
/** Exact single header value. It is an offer, never authority or a capability. */
export function acceptedOffer(offered,confirmed){return offered===VERSION&&confirmed===VERSION;}
export function validateDecisionReply(request,reply,expectation) {
  try {
    requireThat(validateObject(request).valid&&request.type==='decision.request');
    requireThat(validateObject(reply).valid&&reply.type==='decision.reply'&&reply.request_id===request.request_id);
    const r=reply.result;
    if(r.kind==='error'){requireThat(r.error.operation_id===request.request.operation_id);return valid();}
    return decision.validateExchange(request.request,{valid:true,errors:[],...r},expectation).valid?valid():invalid();
  }catch{return invalid();}
}
/** All expected facts are independently held host journal/producer facts. */
export function validateProofResult(message,exchange,selected,authenticatedConnection) {
  try {requireThat(validateObject(message).valid&&message.type==='proof.result');return decision.validateProducerAttestation(message.attestation,exchange,selected,authenticatedConnection).valid?valid():invalid();}catch{return invalid();}
}
const idsMatch=(m,s)=>m.transfer_id===s.transfer_id&&m.transit_id===s.transit_id;
export function validateSession(message,expected) {
  try {requireThat(validateObject(message).valid&&['transit.open','transit.opened'].includes(message.type));sessionRules(expected);requireThat(same(message.session,expected));return valid();}catch{return invalid();}
}
/** Pure byte-cursor decision only, not an append/COMMIT/ACK or F state. */
export function inspectChunk(chunk,session,cursor) {
  try {
    requireThat(validateObject(chunk).valid&&chunk.type==='transit.chunk');sessionRules(session);cursorRules(cursor);requireThat(idsMatch(chunk,session));
    const end=add(chunk.offset,chunk.length);requireThat(exact(end)<=exact(session.stream_bytes));requireThat(chunk.eof===(end===session.stream_bytes));
    const block=Object.fromEntries(['sequence','offset','length','sha256','eof'].map(k=>[k,chunk[k]]));
    if(cursor.last&&same(block,cursor.last))return {valid:true,kind:'retry',cursor:structuredClone(cursor)};
    requireThat(!cursor.eof&&chunk.sequence===cursor.next_sequence&&chunk.offset===cursor.next_offset);
    return {valid:true,kind:'append',cursor:{next_sequence:decision.increment(chunk.sequence),next_offset:end,eof:chunk.eof,last:block}};
  }catch{return invalid();}
}
export function validateAck(ack,chunk,session,expectedRequestId) {
  try {requireThat(validateObject(ack).valid&&ack.type==='transit.ack'&&validateObject(chunk).valid&&chunk.type==='transit.chunk');sessionRules(session);requireThat(chunk.eof===(add(chunk.offset,chunk.length)===session.stream_bytes)&&exact(add(chunk.offset,chunk.length))<=exact(session.stream_bytes));requireThat(ack.request_id===expectedRequestId);requireThat(idsMatch(ack,session)&&idsMatch(chunk,session));for(const k of ['sequence','offset','length','sha256','eof'])requireThat(ack[k]===chunk[k]);requireThat(ack.next_offset===add(chunk.offset,chunk.length));return valid();}catch{return invalid();}
}
/** Choose a decoder before reading. Content remains at its existing owner and
 * admission; a confirmed F response can never fall back into the v2 parser. */
export async function withProducerDelivery(load,ports,context,consume) {
  try {
    requireThat(typeof consume==='function');
    requireThat(context.offered===undefined||context.offered===null||context.offered===VERSION);
    requireThat(context.response_status===200||context.response_status===204);
    if(context.response_status===204){requireThat(context.confirmed===undefined||context.confirmed===null);requireThat(context.response_request_id===context.poll_request_id);await consume({branch:'empty',value:null});return valid();}
    if(context.confirmed===undefined||context.confirmed===null) {
      requireThat(typeof ports?.withContent==='function'&&typeof ports.validateContent==='function');let calls=0,completed=false;
      await ports.withContent(load,async m=>{calls++;requireThat(calls===1&&ports.validateContent(m)===true&&m.type==='delivery'&&m.instance_id===context.instance_id&&m.request_id===context.response_request_id);await consume({branch:'content',value:m});completed=true;});
      requireThat(calls===1&&completed);return valid();
    }
    requireThat(acceptedOffer(context.offered,context.confirmed));
    return await withDecoded(load,ports,async m=>{
      requireThat(m.type==='producer.delivery'&&m.request_id===context.poll_request_id&&context.response_request_id===m.request_id&&m.instance_id===context.instance_id);
      // First v2 poll creates the server generation/connection. These citations
      // are never native authority; compare any independently known selection.
      if(context.producer_generation!==null)requireThat(m.producer_generation===context.producer_generation);
      if(context.connection_id!==null)requireThat(m.connection_id===context.connection_id);
      await consume({branch:'transit',value:m});
    });
  }catch{return invalid();}
}
export function validateChallengeReply(challenge,reply,expectedExchange) {
  try {requireThat(validateObject(challenge).valid&&challenge.type==='decision.challenge'&&validateObject(reply).valid&&reply.type==='decision.exchange'&&reply.request_id===challenge.request_id);F(expectedExchange,'exchange');requireThat(same(reply.exchange,expectedExchange)&&reply.exchange.kind===challenge.kind&&reply.exchange.request_digest===decision.fingerprint('retry-body',challenge.request));return valid();}catch{return invalid();}
}
export function validateReceived(message,expectedExchange,expectedRequestId) {
  try {requireThat(validateObject(message).valid&&message.type==='proof.received'&&message.request_id===expectedRequestId);F(expectedExchange,'exchange');requireThat(same(message.exchange,expectedExchange));return valid();}catch{return invalid();}
}
export function validateProgress(message,expectedSession,expectedRequestId) {
  try {requireThat(validateObject(message).valid&&message.type==='transit.progress'&&idsMatch(message,expectedSession)&&message.request_id===expectedRequestId);sessionRules(expectedSession);requireThat(exact(message.cursor.next_offset)<=exact(expectedSession.stream_bytes)&&message.cursor.eof===(message.cursor.next_offset===expectedSession.stream_bytes));return valid();}catch{return invalid();}
}
/** Match route candidates after strict decoding, before adapter mutation. A
 * parsed route identifies candidates only, never account, rights or authority. */
export function parseRoute(method,path) {
  try {
    requireThat(method==='POST'&&typeof path==='string');
    const root='/pilot/v2/transfers/';requireThat(path.startsWith(root));const parts=path.slice(root.length).split('/');
    const id=x=>F(x,'id'),uuid=x=>F(x,'uuid');
    if(parts[0]==='sources') {
      id(parts[1]);id(parts[2]);
      if(parts.length===4&&['decisions','challenges'].includes(parts[3]))return {kind:'source',action:parts[3],source_instance:parts[1],conversation:parts[2]};
      if(parts.length===8&&parts[3]==='targets'&&parts[5]==='reservations'&&['decisions','challenges'].includes(parts[7])){id(parts[4]);uuid(parts[6]);return {kind:'reserve',action:parts[7],source_instance:parts[1],conversation:parts[2],target_instance:parts[4],transfer_id:parts[6]};}
    }
    if(parts[0]==='known'&&parts.length===3&&['decisions','challenges','transit'].includes(parts[2])){uuid(parts[1]);return {kind:parts[2]==='transit'?'transit-open':parts[2],transfer_id:parts[1]};}
    if(parts[0]==='transits'&&parts.length===3&&['pull','chunk','ack','status','close'].includes(parts[2])){uuid(parts[1]);return {kind:'transit',transit_id:parts[1],action:parts[2]};}
    if(parts[0]==='instances'&&parts.length===3&&['received','attestations'].includes(parts[2])){id(parts[1]);return {kind:'producer',instance_id:parts[1],action:parts[2]};}
    fail();
  }catch{return null;}
}
export function validateRoute(route,message) {
  try {
    requireThat(route!==null&&validateObject(message).valid);const request=message.request;
    if(route.kind==='source') {requireThat(message.type===(route.action==='decisions'?'decision.request':'decision.challenge')&&['lineage.create','reconcile'].includes(request.operation)&&request.transfer_id===undefined);const s=request.body.provenance?.source;requireThat(s&&s.source_instance_id===route.source_instance&&s.source_conversation_id===route.conversation);}
    else if(route.kind==='reserve'){requireThat(message.type===(route.action==='decisions'?'decision.request':'decision.challenge')&&(request.operation==='reserve'||request.operation==='reconcile'&&request.body.binding!==undefined));const b=request.body.binding;requireThat(request.transfer_id===route.transfer_id&&b.provenance.source.source_instance_id===route.source_instance&&b.provenance.source.source_conversation_id===route.conversation&&b.target_instance_id===route.target_instance);}
    else if(['decisions','challenges'].includes(route.kind)){requireThat(message.type===(route.kind==='decisions'?'decision.request':'decision.challenge')&&request.transfer_id===route.transfer_id);}
    else if(route.kind==='transit'){requireThat(message.transit_id===route.transit_id&&message.type==='transit.'+route.action);}
    else if(route.kind==='producer'){requireThat(message.type===(route.action==='received'?'proof.received':'proof.result'));requireThat((message.exchange?.instance_id??message.attestation?.producer_instance_id)===route.instance_id);}
    else if(route.kind==='transit-open'){requireThat(message.type==='transit.open'&&message.session.transfer_id===route.transfer_id);}
    else fail();
    return valid();
  }catch{return invalid();}
}
/** Contextual receiving frontier; consume may stage only the validated plan.
 * The adapter still commits bytes/cursor atomically before sending its ACK. */
export function withChunk(load,ports,session,cursor,consume) {
  return withDecoded(load,ports,async chunk=>{const plan=inspectChunk(chunk,session,cursor);requireThat(plan.valid);await consume(chunk,plan);});
}
