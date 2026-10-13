import { expect,it } from 'bun:test';
import { ContentHost } from './contentHost';
import { ConversationCaptures } from './conversationCaptures';
import { createReviewCaptureService } from './reviewCapture';
import { MacroPilotNativeClient } from './nativeClient';
import type { ContentDelivery } from './contentProtocol';
import type { TextPolicy } from './conversationText';
const memory=() => { let value:string|null=null;return { load: async () => value,compareAndSwap: async (old:string|null,next:string) => { if (old!==value) return false;value=next;return true; } }; };
const epoch=Date.parse('2026-01-01T00:00:00Z');
async function harness() {
  let time=epoch;let text='<think>Visible reflection</think>';let policy:TextPolicy={ revision:'visible-1',secrets:[] };const controller=new AbortController();
  const storage=memory();const captures=new ConversationCaptures({ instanceId:'instance',workspaceId:'workspace',now:()=>time,storage:memory(),policy:()=>policy,source:{ projects:async()=>[],tasks:async()=>[],listConversations:async()=>[],getConversation:async()=>null,activity:()=>({ activity:'idle',generatingMessageId:null }),listMessages:async()=>[] } });
  const host=new ContentHost({ accountId:'account',instanceId:'instance',signal:controller.signal,now:()=>time,conversations:captures,storage,reviews:createReviewCaptureService(),commitReview:async()=>false,reviewRefs:async()=>[],resolveReview:async()=>{throw Error('not_found');},policy:async()=>structuredClone(policy),reflections:{ available:()=>true,validateTarget:async()=>{},observe:async()=>({content:text,metadata:'[]',blocks:[{ content:text.slice(7,-8),partial:false }],turnId:'turn',source:'history',generationId:null}) } });
  await host.initialize();host.enableReflections(true);
  const delivery:ContentDelivery={ transport_version:'2.0',type:'delivery',request_id:'request',account_id:'account',instance_id:'instance',source_session_id:'mobile',authority_binding:'grant',capabilities:['conversations-1','conversation-reflections-1'],expires_at:new Date(epoch+600000).toISOString(),request:{contract_version:'2.0',type:'request',account_id:'account',request_id:'request',operation:'conversation.reflections.read',body:{ref:{instance_id:'instance',kind:'conversation',conversation_id:'conversation'},message_id:'assistant'}} };
  return {host,delivery,controller,authorize:async()=>new Date(time+5000).toISOString(),now:()=>time,rewrite:()=>{text='<think>Changed reflection</think>';},advance:()=>{time+=300001;},changePolicy:()=>{policy={revision:'visible-2',secrets:[]};},journal:()=>storage.load()};
}
it('does not retain reflection text in journal or generic reply cache and revalidates source on retry',async()=>{
  const h=await harness();try {
    const result=await h.host.handle(h.delivery,h.authorize);expect(result.response.type).toBe('response');
    expect(await h.journal()).not.toContain('Visible reflection');
    await h.host.validateReflectionEmission(h.delivery,result,h.authorize);
    h.rewrite();await expect(h.host.validateReflectionEmission(h.delivery,result,h.authorize)).rejects.toThrow('stale_revision');
    const reread=await h.host.handle(h.delivery,h.authorize);expect(reread.response).toMatchObject({type:'response',result:{items:[{text:'Changed reflection'}]}});
  } finally {await h.host.dispose();}
});
it('retains the exact policy and snapshot association across network authorization',async()=>{
  const h=await harness();try {const result=await h.host.handle(h.delivery,h.authorize);
    await expect(h.host.validateReflectionEmission(h.delivery,result,async()=>{h.changePolicy();return h.authorize();})).rejects.toThrow('snapshot_expired');
  } finally {await h.host.dispose();}
});
it('blocks forged application response bodies and emissions lacking the native before-send fence',async()=>{
  const h=await harness();try {
    const result=await h.host.handle(h.delivery,h.authorize);
    const client=new MacroPilotNativeClient();
    await expect(client.requestContent('/pilot/v2/instances/instance/deliveries/request/result',result,new AbortController().signal)).rejects.toThrow('invalid_configuration');
    if (result.response.type==='response' && result.response.operation==='conversation.reflections.read') result.response.result.items[0].text='x'.repeat(result.response.result.items[0].text.length);
    await expect(h.host.validateReflectionEmission(h.delivery,result,h.authorize)).rejects.toThrow('stale_revision');
  } finally {await h.host.dispose();}
});
it.each(['expiry','policy','revocation'] as const)('revalidates %s after mocked credential reads and before network fetch',async mode=>{
  const h=await harness();let delay=false;let emissions=0;
  const account={contract_version:'1.0',type:'account',account_id:'account',identity:{provider:'github',subject:'1',login:'synthetic'},revision:1};
  const session={contract_version:'1.0',type:'device_session',ref:{type:'session',account_id:'account',session_id:'session'},device_id:'device',state:'active',issued_at:new Date(epoch).toISOString(),expires_at:new Date(epoch+86400000).toISOString(),revision:1};
  const values:Record<string,unknown>={macro_pilot_native_v1:{configurationId:'config',relayOrigin:'https://relay.example',account,deviceSession:session,instance:{contract_version:'1.0',type:'instance',ref:{type:'instance',instance_id:'instance'},label:'Synthetic',connection_state:'reachable',supported_contract_versions:['1.0'],revision:1},instanceCreationId:'creation'}};
  const client=new MacroPilotNativeClient({now:()=>new Date(h.now()),randomBytes:size=>new Uint8Array(size).fill(1),sha256:async()=>new Uint8Array(32),getStateSnapshot:async()=>({schemaVersion:1,values}),setStateValue:async(key,value)=>{values[key]=value;return {schemaVersion:1,values};},secretRead:async()=>{if(delay){delay=false;if(mode==='expiry')h.advance();else if(mode==='policy')h.changePolicy();else h.controller.abort();}return 'd'.repeat(43);},secretWrite:async()=>{},secretDelete:async()=>{},fetch:async url=>{if(String(url).endsWith('/me'))return new Response(JSON.stringify({account,device_session:session}),{headers:{'content-type':'application/json'}});emissions++;return new Response(null,{status:204});}});
  try {await client.initialize();const result=await h.host.handle(h.delivery,h.authorize);delay=true;
    await expect(client.requestContent('/pilot/v2/instances/instance/deliveries/request/result',result,new AbortController().signal,{ beforeSend: ()=>h.host.validateReflectionEmission(h.delivery,result,h.authorize) })).rejects.toThrow();expect(emissions).toBe(0);
  } finally {await h.host.dispose();}
});
