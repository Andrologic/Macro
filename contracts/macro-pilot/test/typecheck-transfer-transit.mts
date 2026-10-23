import type {TransitChunk,TransitCursor,TransitSession,TransitDecisionRequest,TransitDecisionReply,DeliveryContext,DeliveryPorts} from '../v2/transfer-transit/validate.mjs';
import {inspectChunk,validateDecisionReply,withDecoded,withProducerDelivery} from '../v2/transfer-transit/validate.mjs';
import type {DecisionExpectation} from '../v2/transfer-decision.js';
export function inspect(chunk:TransitChunk,session:TransitSession,cursor:TransitCursor):void {
 const result=inspectChunk(chunk,session,cursor);if(result.valid){const offset:string=result.cursor.next_offset;void offset;}
 // @ts-expect-error exact counters do not accept JS numbers
 chunk.offset=9007199254740993;
 // @ts-expect-error no gzip/base64 alternative or generic content family
 chunk.encoding='gzip';
}
export async function receive(request:TransitDecisionRequest,reply:TransitDecisionReply,expectation:DecisionExpectation,context:DeliveryContext,ports:DeliveryPorts):Promise<void>{
 validateDecisionReply(request,reply,expectation);
 // @ts-expect-error expectations cannot come from implicit reply context
 validateDecisionReply(request,reply);
 await withDecoded(()=>new Uint8Array(),ports,m=>{const id:string=m.request_id;void id;});
 await withProducerDelivery(async()=>new Uint8Array(),ports,context,d=>{if(d.branch==='transit')void d.value.delivery_id;else if(d.branch==='empty'){const x:null=d.value;void x;}});
}
