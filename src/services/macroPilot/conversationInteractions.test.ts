import { expect, test } from 'bun:test';
import { ConversationInteractions, type InteractionSource, type InteractionState } from './conversationInteractions';
import type { ContentDelivery, ContentRequest, ContentConversationInteractions } from './contentProtocol';
import { validateMessage, validateExchange } from './contentProtocol';
import { taskActionPermissions } from './taskActionAuthorization';
const ref = {instance_id:'instance',kind:'conversation' as const,conversation_id:'chat'};
const policy = {revision:'visible-1',secrets:[],repoPaths:[]};
function setup() {
  let persisted:string|null=null, now=Date.parse('2026-01-01T00:00:00Z'), effects=0, reads=0, authorization=true, failAfterEffect=false;
  let state:InteractionState={question:{assistant_message_id:'message',steps:[{step_id:'choice',prompt:'Quel format ?',choices:['PDF','Texte'],free_text_allowed:false}]},generation_id:null,actions:['answer']};
  const source:InteractionSource={load:async()=>{reads++;return {state:structuredClone(state),fingerprint:state};},execute:async(_body,guard)=>{await guard();effects++;if(failAfterEffect)throw new Error('network');state={question:null,generation_id:null,actions:[]};await guard(true);}};
  const storage={load:async()=>persisted,compareAndSwap:async(old:string|null,next:string)=>{if(old!==persisted)return false;persisted=next;return true;}};
  const events:unknown[]=[];
  const build=()=>new ConversationInteractions({source,storage,now:()=>now,emit:async change=>{events.push(change);}});
  const host=build();let sequence=0;
  const delivery=(operation:string,body:unknown,session='session'):ContentDelivery=>{
    const request:ContentRequest={contract_version:'2.0',type:'request',request_id:`request-${++sequence}`,account_id:'account',operation,body} as ContentRequest;
    return {transport_version:'2.0',type:'delivery',request_id:request.request_id,instance_id:'instance',account_id:'account',source_session_id:session,expires_at:new Date(now+60000).toISOString(),capabilities:['conversations-1','conversation-interactions-1'],request};
  };
  const authorize=async()=>{if(!authorization)throw new Error('forbidden');};
  const run=async(input:ContentDelivery,owner=host)=>{expect(validateMessage(input)).toEqual({valid:true,errors:[]});const result=await owner.handle(input,policy,authorize);expect(validateExchange(input.request,{contract_version:'2.0',type:'response',request_id:input.request_id,account_id:'account',operation:input.request.operation,result})).toEqual({valid:true,errors:[]});return result;};
  const capture=()=>run(delivery('conversation.interactions',{ref})) as Promise<ContentConversationInteractions>;
  const answer=(c:ContentConversationInteractions,key='intent')=>delivery('conversation.interact',{ref,snapshot_id:c.snapshot_id,expected_revision:c.revision,idempotency_key:key,action:'answer',assistant_message_id:'message',answers:[{step_id:'choice',answer:'PDF'}]});
  return {host,build,run,capture,answer,delivery,events,source,authorize,state:(next:InteractionState)=>{state=next;},revoke:()=>{authorization=false;},fail:()=>{failAfterEffect=true;},expire:()=>{now+=300001;},counts:()=>({effects,reads}),journal:()=>persisted};
}
test('standalone question uses native identity; permission and negotiated capability are required',async()=>{
  const s=setup();await s.host.initialize();const capture=await s.capture();const q=s.answer(capture);
  expect(taskActionPermissions(q.request)).toEqual(['respond']);
  const unselected={...q,capabilities:['conversations-1' as const]};expect(validateMessage(unselected).valid).toBe(false);await expect(s.host.handle(unselected,policy,s.authorize)).rejects.toThrow('validation_failed');
  s.revoke();await expect(s.run(q)).rejects.toThrow('forbidden');expect(s.counts().effects).toBe(0);
});
test('answer is at most once, survives restart and never persists prompt or answer text',async()=>{
  const s=setup();await s.host.initialize();const capture=await s.capture();const q=s.answer(capture);expect(await s.run(q)).toEqual({outcome:'applied',revision:2});
  const restarted=s.build();await restarted.initialize();expect(await s.run(q,restarted)).toEqual({outcome:'duplicate',revision:2});expect(s.counts().effects).toBe(1);
  expect(s.journal()).not.toContain('Quel format');expect(s.journal()).not.toContain('PDF');
  const changed=structuredClone(q);if(changed.request.operation==='conversation.interact')changed.request.body.answers![0].answer='Texte';await expect(s.run(changed,restarted)).rejects.toThrow('conflict');
});
test('stale question, cross-session capture, expiration and invalid choice cannot execute',async()=>{
  const s=setup();await s.host.initialize();const c=await s.capture();const q=s.answer(c);
  await expect(s.run({...q,source_session_id:'other'})).rejects.toThrow('snapshot_expired');
  const wrong=structuredClone(q);if(wrong.request.operation==='conversation.interact')wrong.request.body.answers![0].answer='Other';await expect(s.run(wrong)).rejects.toThrow('validation_failed');
  s.state({question:null,generation_id:'generation-new',actions:['stop']});await expect(s.run(q)).rejects.toThrow('stale_revision');expect(s.counts().effects).toBe(0);
  const fresh=await s.capture();s.expire();await expect(s.run(s.delivery('conversation.interact',{ref,snapshot_id:fresh.snapshot_id,expected_revision:fresh.revision,idempotency_key:'stop',action:'stop',generation_id:fresh.generation_id}))).rejects.toThrow('snapshot_expired');
});
test('stop cannot stop a later generation; uncertain effect cannot be replayed after restart',async()=>{
  const s=setup();await s.host.initialize();s.state({question:null,generation_id:'generation-1',actions:['stop']});const c=await s.capture();
  const stop=s.delivery('conversation.interact',{ref,snapshot_id:c.snapshot_id,expected_revision:c.revision,idempotency_key:'stop',action:'stop',generation_id:'generation-1'});
  s.state({question:null,generation_id:'generation-2',actions:['stop']});await expect(s.run(stop)).rejects.toThrow('stale_revision');expect(s.counts().effects).toBe(0);
  s.state({question:{assistant_message_id:'message',steps:[{step_id:'choice',prompt:'Quel format ?',choices:['PDF'],free_text_allowed:false}]},generation_id:null,actions:['answer']});const q=s.answer(await s.capture());s.fail();await expect(s.run(q)).rejects.toThrow('conflict');
  const restarted=s.build();await restarted.initialize();await expect(s.run(q,restarted)).rejects.toThrow('conflict');const fresh=await s.run(s.delivery('conversation.interactions',{ref}),restarted) as ContentConversationInteractions;await expect(s.run(s.answer(fresh,'new-intent'),restarted)).rejects.toThrow('conflict');expect(s.counts().effects).toBe(1);
});
test('observation is bounded even with many open captures',async()=>{const s=setup();await s.host.initialize();for(let i=0;i<12;i++)await s.run(s.delivery('conversation.interactions',{ref:{...ref,conversation_id:`chat-${i}`}}));const before=s.counts().reads;await s.host.observe(policy);expect(s.counts().reads-before).toBe(1);});

test('retired native target unblocks a later generation without replaying uncertainty',async()=>{
  const s=setup(); await s.host.initialize(); const old=s.answer(await s.capture()); s.fail(); await expect(s.run(old)).rejects.toThrow('conflict');
  const restarted=s.build(); await restarted.initialize(); s.state({question:null,generation_id:'new-generation',actions:['stop']});
  const c=await s.run(s.delivery('conversation.interactions',{ref}),restarted) as ContentConversationInteractions;
  const next=s.delivery('conversation.interact',{ref,snapshot_id:c.snapshot_id,expected_revision:c.revision,idempotency_key:'next-generation',action:'stop',generation_id:'new-generation'});
  await expect(s.run(next,restarted)).rejects.toThrow('conflict'); expect(s.counts().effects).toBe(2);
  await expect(s.run(old,restarted)).rejects.toThrow('conflict'); expect(s.counts().effects).toBe(2);
});
