import type {DecisionExpectation,DecisionExchange,DecisionProducer} from '../transfer-decision.js';
import type {TransitMessage,TransitSession,TransitCursor,TransitChunk,TransitAck,TransitDecisionRequest,TransitDecisionReply,TransitAttestation,TransitChallenge,TransitExchange,TransitReceived,TransitStatus,TransitDelivery} from './types.generated.mjs';
export * from './types.generated.mjs';
export type Validation={valid:true}|{valid:false;code:'validation_failed'};
export type Reserve=(units:number)=>()=>void;
export interface DecodePorts {reserve:Reserve}
export interface DeliveryContext {offered:string|null|undefined;confirmed:string|null|undefined;poll_request_id:string;response_request_id:string;response_status:200|204;instance_id:string;producer_generation:string|null;connection_id:string|null}
export interface DeliveryPorts extends DecodePorts {
  /** The existing v2 owner supplies its independent admission and decoding. */
  withContent(load:()=>Promise<Uint8Array>,consume:(message:unknown)=>Promise<void>):Promise<unknown>;
  validateContent(message:unknown):boolean;
}
export const IDENTITIES:Readonly<{content_contract_sha256:string;decision_resource_set_sha256:string;decision_resources:ReadonlyArray<{path:string;sha256:string}>}>;
export const LIMITS:Readonly<{raw:65536;dataJson:94208;body:98304;controls:4096;graph:25165824;working:1048576;copies:2097152;admission:28311552}>;
export const OFFER_HEADER:'X-Macro-Transfer-Transit';
export const VERSION:'transfer-transit-1';
export function assertUnicode(text:string):void;
export function utf8JsonSize(text:string):{bytes:number;json:number};
export function blockPrefix(text:string):{units:number;bytes:number;json:number};
export function validateObject(message:unknown):Validation;
export function withDecoded(load:()=>unknown|Promise<unknown>,ports:DecodePorts,consume:(message:TransitMessage)=>void|Promise<void>):Promise<Validation>;
export function diagnosticsEmpty():boolean;
export function acceptedOffer(offered:unknown,confirmed:unknown):boolean;
export function validateDecisionReply(request:TransitDecisionRequest,reply:TransitDecisionReply,expectation:DecisionExpectation|undefined):Validation;
export function validateProofResult(message:TransitAttestation,exchange:DecisionExchange,selected:DecisionProducer,authenticatedConnection:string):Validation;
export function validateSession(message:unknown,expected:TransitSession):Validation;
export function inspectChunk(chunk:TransitChunk,session:TransitSession,cursor:TransitCursor):{valid:true;kind:'append'|'retry';cursor:TransitCursor}|{valid:false;code:'validation_failed'};
export function validateAck(ack:TransitAck,chunk:TransitChunk,session:TransitSession,expectedRequestId:string):Validation;
export function withProducerDelivery(load:()=>Promise<Uint8Array>,ports:DeliveryPorts,context:DeliveryContext,consume:(delivery:{branch:'transit';value:TransitDelivery}|{branch:'content';value:unknown}|{branch:'empty';value:null})=>void|Promise<void>):Promise<Validation>;
export function validateChallengeReply(challenge:TransitChallenge,reply:TransitExchange,expectedExchange:DecisionExchange):Validation;
export function validateReceived(message:TransitReceived,exchange:DecisionExchange,expectedRequestId:string):Validation;
export function validateProgress(message:TransitStatus,expected:TransitSession,expectedRequestId:string):Validation;
export type Route={kind:'source';action:'decisions'|'challenges';source_instance:string;conversation:string}|{kind:'reserve';action:'decisions'|'challenges';source_instance:string;conversation:string;target_instance:string;transfer_id:string}|{kind:'decisions'|'challenges'|'transit-open';transfer_id:string}|{kind:'transit';transit_id:string;action:'pull'|'chunk'|'ack'|'status'|'close'}|{kind:'producer';instance_id:string;action:'received'|'attestations'};
export function parseRoute(method:string,path:string):Route|null;
export function validateRoute(route:Route|null,message:unknown):Validation;
export function withChunk(load:()=>unknown|Promise<unknown>,ports:DecodePorts,session:TransitSession,cursor:TransitCursor,consume:(chunk:TransitChunk,plan:{valid:true;kind:'append'|'retry';cursor:TransitCursor})=>void|Promise<void>):Promise<Validation>;
