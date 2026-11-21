import type {AuthorityRequest,AuthorityResponse} from './types.generated.mjs';
export * from './types.generated.mjs';
export {IDENTITIES} from './identities.generated.mjs';
export type Validation={valid:true}|{valid:false;code:'validation_failed'};
export type Kind='request'|'response';
export interface Charges {working:number;copies:number}
export interface DecodePorts {
  /** Same process/instance quota as v2 and transit, never a private counter. */
  reserve(units:number):()=>void;
  /** Additional live host work/copies. Existing HTTP/TLS owners keep theirs. */
  charges:Charges;
}
export interface ExpectedTransport {
  request_id_header:string;
  response_request_id_header:string;
  expected_origin:string;
  connection_origin:string;
  account_id:string;
}
export interface TimeReading {now_ms:number;dispatch_age_ms:number}
export const VERSION:'transfer-authority-1';
export const ROUTE:'/pilot/v2/transfer-authority/preflight';
export const LIMITS:Readonly<{request:4096;response:8192;graphMultiplier:256;workingMultiplier:16;copiesMultiplier:8;maxAgeMs:30000}>;
export function validateObject(message:unknown):Validation;
export function validateRequest(request:AuthorityRequest,requestIdHeader:string):Validation;
export function matchesRoute(method:string,path:string):boolean;
export function admissionUnits(kind:Kind,charges:Charges):number;
export function withDecoded<K extends Kind>(kind:K,load:()=>unknown|Promise<unknown>,ports:DecodePorts,consume:(message:K extends 'request'?AuthorityRequest:AuthorityResponse)=>void|Promise<void>):Promise<Validation>;
export function withRequest(load:()=>unknown|Promise<unknown>,ports:DecodePorts,requestIdHeader:string,consume:(request:AuthorityRequest)=>void|Promise<void>):Promise<Validation>;
export function validateResponse(request:AuthorityRequest,response:AuthorityResponse,expected:ExpectedTransport,time:TimeReading):Validation;
export function withResponse(load:()=>unknown|Promise<unknown>,ports:DecodePorts,request:AuthorityRequest,expected:ExpectedTransport,readTime:()=>TimeReading,consume:(response:AuthorityResponse)=>void|Promise<void>):Promise<Validation>;
export function diagnosticsEmpty():boolean;
