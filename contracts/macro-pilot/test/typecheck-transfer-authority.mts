import type {AuthorityRequest,AuthorityResponse,AuthorityControllerSnapshot,DecodePorts,ExpectedTransport,TimeReading} from '../v2/transfer-authority/validate.mjs';
import {validateResponse,withRequest,withResponse} from '../v2/transfer-authority/validate.mjs';
export async function receive(request:AuthorityRequest,response:AuthorityResponse,ports:DecodePorts,expected:ExpectedTransport,time:TimeReading,controller:AuthorityControllerSnapshot):Promise<void> {
  validateResponse(request,response,expected,time);
  // @ts-expect-error transport and dispatch time are mandatory
  validateResponse(request,response);
  // @ts-expect-error no authentication claim is carried by the body
  response.authenticated=true;
  // @ts-expect-error producers in snapshots are active only
  controller.source_producer.state='inactive';
  // @ts-expect-error exact i64 revisions remain strings
  controller.actor.account_epoch=1;
  await withRequest(()=>'',ports,request.request_id,q=>{const id:string=q.request_id;void id;});
  await withResponse(()=>'',ports,request,expected,()=>time,r=>{if(r.type==='authority_error'){const code:string=r.code;void code;}else if(r.scope.kind==='producer'){void r.scope.instance_id;}});
}
