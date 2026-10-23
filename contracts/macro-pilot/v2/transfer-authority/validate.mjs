import {message as shape, clearErrors, diagnosticsEmpty as shapeDiagnosticsEmpty} from './shape.generated.mjs';
import * as decision from '../transfer-transit/decision-browser.generated.mjs';
import {parseStoredJsonStrict} from '../strict-json.mjs';
export {IDENTITIES} from './identities.generated.mjs';

export const VERSION = 'transfer-authority-1';
export const ROUTE = '/pilot/v2/transfer-authority/preflight';
// Logical quota units, not heap/RSS bounds. Each decoding owner keeps its full
// charge through consumption; the host adds its own live work and copies.
export const LIMITS = Object.freeze({request:4096,response:8192,graphMultiplier:256,workingMultiplier:16,copiesMultiplier:8,maxAgeMs:30000});
const encoder = new TextEncoder();
const requireThat = condition => {if(!condition)throw Error('validation_failed');};
const valid = () => ({valid:true});
const invalid = () => ({valid:false,code:'validation_failed'});
const F = (value,definition) => requireThat(decision.validateObject(value,definition).valid);
const same = (a,b) => decision.canonicalJson(a)===decision.canonicalJson(b);
const nonnegative = n => Number.isSafeInteger(n)&&n>=0;
function httpsOrigin(value) {F(value,'origin');requireThat(new URL(value).protocol==='https:');}
function date(value) {
  const ms=Date.parse(value);
  requireThat(Number.isFinite(ms)&&new Date(ms).toISOString()===value);
  return ms;
}
function scopeRules(scope) {
  if(scope.kind==='controller')requireThat(scope.target_instance_id===null||scope.source_instance_id!==scope.target_instance_id);
}
function producerRules(producer,account,instance) {
  F(producer,'producer');
  requireThat(producer.state==='active'&&producer.account_id===account&&producer.instance_id===instance);
}
function rules(message) {
  if(message.type==='authority_error') {
    requireThat(message.retryable===['unavailable','instance_offline'].includes(message.code));
    return;
  }
  scopeRules(message.scope);
  if(message.type==='preflight')return;
  httpsOrigin(message.authority_origin);
  const issued=date(message.issued_at),expires=date(message.expires_at);
  requireThat(expires>issued&&expires-issued<=LIMITS.maxAgeMs);
  const scope=message.scope;
  if(scope.kind==='producer')producerRules(message.producer,message.producer.account_id,scope.instance_id);
  else {
    F(message.actor,'actor');
    producerRules(message.source_producer,message.actor.account_id,scope.source_instance_id);
    if(scope.target_instance_id===null)requireThat(message.target_producer===null&&message.actor.target_access_revision===message.actor.source_access_revision);
    else producerRules(message.target_producer,message.actor.account_id,scope.target_instance_id);
    F(message.recovery_generation,'uuid');
  }
}
/** Already admitted plain data only. This validates no authentication or rights. */
export function validateObject(message) {
  try {
    // Inspect descriptors before AJV so an accessor is never invoked as data.
    const raw=decision.canonicalJson(message);
    try {requireThat(shape(message)===true);}finally{clearErrors();}
    requireThat(encoder.encode(raw).length<=(message.type==='preflight'?LIMITS.request:LIMITS.response));
    rules(message);
    return valid();
  }catch{return invalid();}finally{clearErrors();}
}
export function validateRequest(request,requestIdHeader) {
  try {requireThat(validateObject(request).valid&&request.type==='preflight'&&request.request_id===requestIdHeader);return valid();}catch{return invalid();}
}
export function matchesRoute(method,path) {return method==='POST'&&path===ROUTE;}
/** Host-provided external charges are mandatory, including when zero. The
 * shared quota owner may reject; this module creates no independent counter. */
export function admissionUnits(kind,charges) {
  requireThat(kind==='request'||kind==='response');
  requireThat(nonnegative(charges?.working)&&nonnegative(charges?.copies));
  const limit=LIMITS[kind];
  const units=limit*(LIMITS.graphMultiplier+LIMITS.workingMultiplier+LIMITS.copiesMultiplier)+charges.working+charges.copies;
  requireThat(Number.isSafeInteger(units));return units;
}
/** Reserve before even calling load. Input and parsed views belong only to
 * consume's lifetime; retention requires a separate host-owned charge. */
export async function withDecoded(kind,load,ports,consume) {
  let release,result=invalid();
  try {
    requireThat(typeof load==='function'&&typeof ports?.reserve==='function'&&typeof consume==='function');
    const units=admissionUnits(kind,ports.charges);
    release=ports.reserve(units);requireThat(typeof release==='function');
    let input=await load(),raw;
    const limit=LIMITS[kind];
    if(typeof input==='string') {
      requireThat(input.length<=limit);decision.canonicalJson(input);
      requireThat(encoder.encode(input).length<=limit);raw=input;
    }else {
      requireThat(input instanceof Uint8Array&&input.byteLength<=limit);
      raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);
    }
    let message=parseStoredJsonStrict(raw);
    requireThat(validateObject(message).valid&&(kind==='request'?message.type==='preflight':message.type!=='preflight'));
    await consume(message);
    message=null;raw=null;input=null;result=valid();
  }catch{result=invalid();}finally{clearErrors();if(typeof release==='function'){try{release();}catch{result=invalid();}}}
  return result;
}
export function withRequest(load,ports,requestIdHeader,consume) {
  return withDecoded('request',load,ports,async request=>{requireThat(validateRequest(request,requestIdHeader).valid);await consume(request);});
}
/** expected is held independently by the authenticated transport and local
 * session owner. Neither connection origin nor dispatch age comes from JSON.
 * The caller must still enforce current authorization and generation guards. */
export function validateResponse(request,response,expected,time) {
  try {
    requireThat(validateRequest(request,expected?.request_id_header).valid);
    requireThat(validateObject(response).valid&&response.type!=='preflight');
    requireThat(response.request_id===request.request_id&&expected.response_request_id_header===request.request_id);
    F(expected.account_id,'id');httpsOrigin(expected.expected_origin);httpsOrigin(expected.connection_origin);
    requireThat(expected.connection_origin===expected.expected_origin);
    requireThat(Number.isSafeInteger(time?.now_ms)&&Number.isFinite(time?.dispatch_age_ms)&&time.dispatch_age_ms>=0&&time.dispatch_age_ms<LIMITS.maxAgeMs);
    if(response.type==='authority_error')return valid();
    requireThat(same(response.scope,request.scope)&&response.authority_origin===expected.expected_origin);
    const issued=date(response.issued_at),expires=date(response.expires_at);
    requireThat(issued<=time.now_ms&&time.now_ms<expires&&time.dispatch_age_ms<expires-issued);
    if(response.scope.kind==='producer')requireThat(response.producer.account_id===expected.account_id);
    else requireThat(response.actor.account_id===expected.account_id);
    return valid();
  }catch{return invalid();}finally{clearErrors();}
}
/** readTime executes after awaited I/O, immediately before consumption. Its
 * dispatch clock is the transport owner's monotone reading, not server time. */
export function withResponse(load,ports,request,expected,readTime,consume) {
  return withDecoded('response',load,ports,async response=>{
    requireThat(typeof readTime==='function'&&typeof consume==='function');
    requireThat(validateResponse(request,response,expected,readTime()).valid);
    await consume(response);
  });
}
export const diagnosticsEmpty = () => shapeDiagnosticsEmpty()&&decision.diagnosticsEmpty();
