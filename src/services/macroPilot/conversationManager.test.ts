import { expect, test } from 'bun:test';
import { ConversationManager, type ConversationManagementSource } from './conversationManager';
import { ConversationCaptures, type CapturePage, type MessageItem, type ConversationActivity } from './conversationCaptures';
import { ContentHost } from './contentHost';
import { createReviewCaptureService } from './reviewCapture';
import { validateMessage, validateExchange, type ContentConversationCard, type ContentConversationSearchHit, type ContentDelivery, type ContentRequest } from './contentProtocol';
import type { DbConversation, DbMessage, ConversationMetadata } from '../tauriIpc';
import type { KernelStorage } from './kernel';
import { taskActionPermissions, assertTaskActionPermissions } from './taskActionAuthorization';
const policy = { revision: 'visible-1', secrets: ['synthetic-secret'] };
const memory = (): KernelStorage => { let value: string | null = null; return { load: async () => value, compareAndSwap: async (before,after) => { if (before !== value) return false; value = after; return true; } }; };
const conversation = (id: string): DbConversation => ({ id, title: `Chat ${id}`, description: 'Résumé utile', scope_mode: 'Chat', task_id: null, project_id: 'project', group_id: null, provider_id: null, model_id: null, reasoning_effort: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_message: 'synthetic-secret', message_count: 0, is_pinned: false });
const message = (id: string, c: string, content = 'Café déjà prêt'): DbMessage => ({ id, conversation_id:c,role:'assistant',content,created_at:'2026-01-01T00:00:00Z',token_count:null,hidden_context:'synthetic-secret',tool_traces_json:null,provider_input_items_json:null,provider_turn_state_json:null,completion_reason:'completed' });
function setup(count = 1) {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const conversations = Array.from({length:count},(_,i) => conversation(`chat-${String(i).padStart(3,'0')}`));
  const metadata: ConversationMetadata[] = conversations.map(c => ({ conversation_id:c.id,revision:1,archived:false,response_revision:0,read_revision:0,pending_tool:false,provider_failed:false,question_message_id:null,preview_message_id:null }));
  const messages: DbMessage[] = [];
  const activities = new Map<string, ConversationActivity>();
  let acknowledgementDeadline: string | undefined;
  let transcriptReads = 0; let messageReads = 0; let syncCalls = 0; let mutations = 0; let finalProvenance = true;
  let searchOffsets: number[] = [];
  const revisions = new Map<string,number>();
  const observedRevisions = new Set<number>();
  const receipts = new Map<string,{digest:string;conversation_id:string;revision:number}>();
  const source: ConversationManagementSource = {
    projects:async () => [{id:'project',name:'Synthetic project'}], tasks:async () => [],
    listConversations:async () => structuredClone(conversations), getConversation:async id => structuredClone(conversations.find(c=>c.id===id)??null),
    metadata:async () => structuredClone(metadata), catalogMetadata:async () => structuredClone(metadata),
    listMessages:async id => { transcriptReads++; return structuredClone(messages.filter(m=>m.conversation_id===id)); },
    activity:id => activities.get(id)??{activity:'idle',generatingMessageId:null}, finalProvenance:async m=>finalProvenance?m.content:null,
    message:async id=>{ messageReads++; return structuredClone(messages.find(m=>m.id===id)??null); },
    responseVersion:async m=>{ if (messages.find(row=>row.id===m.id)?.content!==m.content) throw new Error('stale_revision'); return revisions.get(m.id)??0; },
    acknowledge:async (id,observed,deadline)=>{ acknowledgementDeadline=deadline; const state=metadata.find(m=>m.conversation_id===id)!;observed.forEach(r=>observedRevisions.add(r)); const unread=messages.filter(m=>m.conversation_id===id && m.role==='assistant' && !observedRevisions.has(revisions.get(m.id)!)).map(m=>revisions.get(m.id)!);state.read_revision=unread.length?Math.min(...unread)-1:state.response_revision; },
    synchronize:async ()=>{syncCalls++;},
    search:async (_query,ids,offset)=>{searchOffsets.push(offset); const found=messages.filter(m=>ids.includes(m.conversation_id));return {results:found.slice(offset,offset+50).map(m=>({messageId:m.id,conversationId:m.conversation_id,conversationTitle:'Synthetic',conversationDescription:null,role:m.role,snippet:'UNSAFE raw snippet synthetic-secret',createdAt:m.created_at})),nextOffset:offset+50<found.length?offset+50:null};},
    action:async input=>{
      const old=receipts.get(input.receipt_key);
      if(old){if(old.digest!==input.digest)throw new Error('conflict');return {outcome:'duplicate',conversation_id:old.conversation_id,revision:old.revision};}
      const c=conversations.find(c=>c.id===input.conversation_id);
      const state=metadata.find(m=>m.conversation_id===input.conversation_id);
      if(input.action==='create') { conversations.push({...conversation(input.conversation_id),title:input.title??'New Chat',project_id:input.project_id});metadata.push({conversation_id:input.conversation_id,revision:1,archived:false,response_revision:0,read_revision:0,pending_tool:false,provider_failed:false,question_message_id:null,preview_message_id:null}); }
      else { if(!c||!state)throw new Error('not_found');if(state.revision!==input.expected_revision)throw new Error('stale_revision');if(c.scope_mode!=='Chat')throw new Error('forbidden');state.revision++;
        if(input.action==='rename')c.title=input.title!;if(input.action==='pin'||input.action==='unpin')c.is_pinned=input.action==='pin';if(input.action==='archive'||input.action==='restore')state.archived=input.action==='archive'; }
      mutations++; const revision=input.action==='create'?1:state!.revision;receipts.set(input.receipt_key,{digest:input.digest,conversation_id:input.conversation_id,revision});return {outcome:'applied',conversation_id:input.conversation_id,revision};
    },
  };
  const captures = new ConversationCaptures({instanceId:'instance',workspaceId:'workspace',source,storage:memory(),policy:()=>policy,now:()=>clock});
  const manager = new ConversationManager({instanceId:'instance',source,captures,storage:memory(),now:()=>clock});
  let req = 0;
  const delivery = (operation: string, body: unknown, session = 'session', account = 'account'): ContentDelivery => ({transport_version:'2.0',type:'delivery',request_id:`request-${++req}`,instance_id:'instance',account_id:account,source_session_id:session,expires_at:new Date(clock+300000).toISOString(),capabilities:['conversations-1',...((body as {direction?:string}).direction==='backward'?['conversation-history-1' as const]:[])],request:{contract_version:'2.0',type:'request',request_id:`request-${req}`,account_id:account,operation,body} as ContentRequest});
  const read = async (operation:string,body:unknown,session?:string,account?:string) => {const input=delivery(operation,body,session,account);expect(validateMessage(input).valid).toBe(true);const result=await manager.handle(input,policy,async()=>new Date(clock+10000).toISOString());expect(validateExchange(input.request,{contract_version:'2.0',type:'response',request_id:input.request_id,account_id:input.account_id,operation,result})).toEqual({valid:true,errors:[]});return result;};
  const add = (m:DbMessage) => {messages.push(m);const state=metadata.find(s=>s.conversation_id===m.conversation_id)!;state.response_revision++;revisions.set(m.id,state.response_revision);};
  const ref = {instance_id:'instance',kind:'conversation' as const,conversation_id:conversations[0].id};
  return {manager,captures,source,conversations,metadata,messages,activities,delivery,read,ref,add,revisions,clock:()=>clock,expire:()=>{clock+=300001;}, counts:()=>({acknowledgementDeadline,transcriptReads,messageReads,syncCalls,mutations,searchOffsets}),withhold:()=>{finalProvenance=false;}, clear:()=>manager.clear()};
}
test('catalog is bounded, pinned then recent, paginated and never loads transcripts',async()=>{
  const s=setup(125);s.conversations[124].is_pinned=true;s.conversations[123].updated_at='2026-01-02T00:00:00Z';s.conversations[0].description='x'.repeat(800);s.conversations[0].title='😀'.repeat(400);
  const first=await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation'}) as CapturePage<ContentConversationCard>;
  expect(first.items.length).toBe(50);expect(first.page.total).toBe(125);expect(first.items[0].ref.conversation_id).toBe('chat-124');expect(first.items[1].ref.conversation_id).toBe('chat-123');
  const card=first.items.find(c=>c.ref.conversation_id==='chat-000')!;expect(Array.from(card.title).length).toBe(240);expect(card.description.length).toBe(320);expect(card.project?.name).toBe('Synthetic project');expect(card.updated_at).toBe('2026-01-01T00:00:00.000Z');
  const second=await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation',continuation:{snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor}}) as CapturePage<ContentConversationCard>;
  const last=await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation',continuation:{snapshot_id:second.page.snapshot_id,cursor:second.page.next_cursor}}) as CapturePage<ContentConversationCard>;
  expect(last.items.length).toBe(25);expect(new Set([...first.items,...second.items,...last.items].map(c=>c.ref.conversation_id)).size).toBe(125);expect(s.counts().transcriptReads).toBe(0);expect(JSON.stringify(first)).not.toContain('synthetic-secret');
});
test('filters evaluate the entire catalog, including archives and unloaded attention',async()=>{
  const s=setup(105);s.metadata[104].response_revision=4;s.metadata[103].archived=true;s.activities.set('chat-102',{activity:'idle',generatingMessageId:null,attention:'tool_approval'});s.activities.set('chat-101',{activity:'busy',generatingMessageId:'active'});s.activities.set('chat-100',{activity:'error',generatingMessageId:null,providerFailure:{category:'quota',message:'provider_quota_exceeded',recovery:'desktop_action'}});
  const catalog=async(filter:unknown)=>(await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation',filter}) as CapturePage<ContentConversationCard>).items;
  expect((await catalog({attention:'unread'})).map(c=>c.ref.conversation_id)).toEqual(['chat-104']);expect((await catalog({archived:'archived'})).map(c=>c.ref.conversation_id)).toEqual(['chat-103']);expect((await catalog({attention:'running'}))[0].attention).toBe('generating');
  const attention=await catalog({attention:'needs_attention'});expect(attention.map(c=>c.attention)).toEqual(['error','tool_approval']);expect(attention[0].provider_error?.category).toBe('quota');expect(s.counts().transcriptReads).toBe(0);
});
test('catalog cursors reject scope changes, mutations, policy purge and expiry',async()=>{
  const s=setup(52);const first=await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation'}) as CapturePage<ContentConversationCard>;
  const body={instance_id:'instance',kind:'conversation',continuation:{snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor}};
  for(const [session,account] of [['other','account'],['session','other']]) await expect(s.read('conversations.catalog',body,session,account)).rejects.toThrow('validation_failed');
  await expect(s.read('conversations.catalog',{...body,filter:{attention:'unread'}})).rejects.toThrow('validation_failed');s.metadata[0].archived=true;await expect(s.read('conversations.catalog',body)).rejects.toThrow('stale_revision');
  s.expire();await expect(s.read('conversations.catalog',body)).rejects.toThrow('snapshot_expired');s.clear();await expect(s.read('conversations.catalog',body)).rejects.toThrow('snapshot_expired');
});
test('searches all metadata and indexed messages, ignoring accents and exporting only controlled excerpts',async()=>{
  const s=setup(2);s.conversations[0].description='x'.repeat(500)+' Café déjà prêt';
  for(let i=0;i<55;i++)s.add(message(`answer-${String(i).padStart(3,'0')}`,s.ref.conversation_id));
  s.add(message('unsafe',s.conversations[1].id,'Café synthetic-secret'));s.add(message('late',s.conversations[1].id,'x'.repeat(20000)+' café déjà prêt'));
  const first=await s.read('conversations.search',{instance_id:'instance',kind:'conversation',query:'CAFE DEJA PRET'}) as CapturePage<ContentConversationSearchHit>;
  expect(first.page.total).toBe(57);expect(first.items[0].source).toBe('metadata');expect(first.items[0].excerpt).toContain('Café');expect(s.counts().searchOffsets).toEqual([0,50]);expect(s.counts().transcriptReads).toBe(0);expect(JSON.stringify(first)).not.toContain('UNSAFE');expect(JSON.stringify(first)).not.toContain('synthetic-secret');
  const second=await s.read('conversations.search',{instance_id:'instance',kind:'conversation',query:'CAFE DEJA PRET',continuation:{snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor}}) as CapturePage<ContentConversationSearchHit>;
  expect(second.items.some(hit=>hit.message_id==='late')).toBe(true);
});
test('search hits carry controlled card titles outside the first loaded catalog page without extra histories',async()=>{
  const s=setup(65);const target=s.conversations[60];const withheld=s.conversations[61];
  target.title='Café '+ '😀'.repeat(300);withheld.title='Private synthetic-secret';withheld.description='Café demande contrôlée';
  s.add(message('outside-page',target.id,'Café réponse utile'));s.add(message('withheld-title',withheld.id,'Café réponse utile'));
  const first=await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation'}) as CapturePage<ContentConversationCard>;
  expect(first.items).toHaveLength(50);expect(first.items.some(card=>[target.id,withheld.id].includes(card.ref.conversation_id))).toBe(false);
  const found=await s.read('conversations.search',{instance_id:'instance',kind:'conversation',query:'CAFE'}) as CapturePage<ContentConversationSearchHit>;
  expect(found.items).toHaveLength(4);
  const rest=await s.read('conversations.catalog',{instance_id:'instance',kind:'conversation',continuation:{snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor}}) as CapturePage<ContentConversationCard>;
  for(const id of [target.id,withheld.id]){
    const card=rest.items.find(card=>card.ref.conversation_id===id)!;
    const hits=found.items.filter(hit=>hit.ref.conversation_id===id);
    expect(hits.map(hit=>hit.source)).toEqual(['metadata','message']);
    for(const hit of hits){expect(hit.title).toBe(card.title);expect(Array.from(hit.title).length).toBeLessThanOrEqual(240);}
  }
  expect(found.items.find(hit=>hit.ref.conversation_id===target.id)?.title).toBe('Café '+ '😀'.repeat(235));
  expect(found.items.filter(hit=>hit.ref.conversation_id===withheld.id).every(hit=>hit.title==='')).toBe(true);
  expect(JSON.stringify(found)).not.toContain('synthetic-secret');expect(s.counts().transcriptReads).toBe(0);expect(s.counts().messageReads).toBe(2);
});
test('search excerpts retain the match after composed, decomposed and expanded Unicode prefixes',async()=>{
  for (const prefix of ['é'.repeat(500), 'e\u0301'.repeat(500), '각'.repeat(500), '😀'.repeat(500)]) {
    const s=setup();s.conversations[0].description=prefix+' café '+ 'tail '.repeat(5000);s.add(message('unicode-result',s.ref.conversation_id,s.conversations[0].description));
    const page=await s.read('conversations.search',{instance_id:'instance',kind:'conversation',query:'CAFE'}) as CapturePage<ContentConversationSearchHit>;
    expect(page.items.map(hit=>hit.source)).toEqual(['metadata','message']);
    for(const hit of page.items){expect(hit.excerpt).toContain('café');expect(Array.from(hit.excerpt).length).toBeLessThanOrEqual(320);expect(hit.excerpt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);}
  }
});
test('found message loads an anchored bounded window and acknowledgement preserves a concurrent response',async()=>{
  const s=setup();for(let i=0;i<140;i++)s.add(message(`answer-${String(i).padStart(3,'0')}`,s.ref.conversation_id));
  const page=await s.read('conversation.window',{ref:s.ref,message_id:'answer-110'}) as CapturePage<MessageItem>&{read_token:string};
  expect(page.page.offset).toBe(105);expect(page.items.some(m=>m.message_id==='answer-110')).toBe(true);expect(page.items.length).toBeLessThanOrEqual(50);expect(page.read_token).toBeString();
  await s.read('conversation.acknowledge',{ref:s.ref,read_token:page.read_token});expect(s.metadata[0].read_revision).toBe(0);expect(s.counts().acknowledgementDeadline).toBe(new Date(s.clock()+10000).toISOString());
  s.add(message('concurrent',s.ref.conversation_id));await s.read('conversation.acknowledge',{ref:s.ref,read_token:page.read_token});expect(s.metadata[0].response_revision).toBeGreaterThan(s.metadata[0].read_revision);
  await expect(s.read('conversation.acknowledge',{ref:s.ref,read_token:page.read_token},'other')).rejects.toThrow('snapshot_expired');s.clear();await expect(s.read('conversation.acknowledge',{ref:s.ref,read_token:page.read_token})).rejects.toThrow('snapshot_expired');
});
test('large Unicode messages stay inside content envelope limits and pending/withheld output cannot be acknowledged',async()=>{
  const s=setup();for(let i=0;i<50;i++)s.add(message(`big-${String(i).padStart(3,'0')}`,s.ref.conversation_id,'😀'.repeat(5000)));
  const page=await s.read('conversation.window',{ref:s.ref}) as CapturePage<MessageItem>&{read_token:string};expect(page.items.length).toBeLessThan(50);expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(240*1024);
  const pending=setup();pending.add(message('generating',pending.ref.conversation_id));pending.activities.set(pending.ref.conversation_id,{activity:'busy',generatingMessageId:'generating'});
  expect((await pending.read('conversation.window',{ref:pending.ref}) as {read_token:null}).read_token).toBeNull();
  const withheld=setup();withheld.add(message('unproven',withheld.ref.conversation_id));withheld.withhold();expect((await withheld.read('conversation.window',{ref:withheld.ref}) as {read_token:null}).read_token).toBeNull();
});
test('Chat management checks revisions, scope and idempotent replay and creates a ready context without duplication',async()=>{
  const s=setup();const body={ref:s.ref,expected_revision:1,idempotency_key:'rename-1',action:'rename',title:'Renommé'};
  await s.read('conversation.action',body);await s.read('conversation.action',body);expect(s.counts().mutations).toBe(1);expect(s.conversations[0].title).toBe('Renommé');
  await expect(s.read('conversation.action',{...body,title:'Other'})).rejects.toThrow('conflict');await expect(s.read('conversation.action',{...body,idempotency_key:'other'})).rejects.toThrow('stale_revision');
  await s.read('conversation.action',{ref:s.ref,expected_revision:2,idempotency_key:'pin-1',action:'pin'});expect(s.conversations[0].is_pinned).toBe(true);
  const create={instance_id:'instance',idempotency_key:'create-1',title:'Nouvelle discussion',project_id:'project'};const first=await s.read('conversation.create',create);expect(await s.read('conversation.create',create)).toMatchObject({...first as object,outcome:'duplicate'});expect(s.conversations.length).toBe(2);expect(s.conversations[1].scope_mode).toBe('Chat');
  await expect(s.read('conversation.create',{...create,idempotency_key:'absent',project_id:'absent'})).rejects.toThrow('not_found');
  s.conversations[0].scope_mode='Architect';await expect(s.read('conversation.action',{ref:s.ref,expected_revision:3,idempotency_key:'arch',action:'archive'})).rejects.toThrow('not_found');
});
test('host gates new operations on capability and current account authorization, and purges tickets on disposal',async()=>{
  const s=setup();s.add(message('answer',s.ref.conversation_id));const controller=new AbortController();const host=new ContentHost({accountId:'account',instanceId:'instance',signal:controller.signal,conversations:s.captures,conversationManagement:s.manager,storage:memory(),reviews:createReviewCaptureService(),reviewRefs:async()=>[],resolveReview:async()=>{throw new Error('not_found');},commitReview:async()=>false,policy:async()=>policy,now:s.clock});await host.initialize();
  const denied=s.delivery('conversation.create',{instance_id:'instance',idempotency_key:'denied'});await expect(host.handle(denied,async()=>{throw new Error('forbidden');})).rejects.toThrow('forbidden');expect(s.counts().mutations).toBe(0);
  const foreign=s.delivery('conversations.catalog',{instance_id:'instance',kind:'conversation'},'session','other');await expect(host.handle(foreign,async()=>new Date(s.clock()+10000).toISOString())).rejects.toThrow('validation_failed');
  const unattested=s.delivery('conversation.create',{instance_id:'instance',idempotency_key:'denied'});unattested.capabilities=[];await expect(host.handle(unattested,async()=>new Date(s.clock()+10000).toISOString())).rejects.toThrow('validation_failed');
  const granted=s.delivery('conversation.create',{instance_id:'instance',idempotency_key:'allowed'});expect(taskActionPermissions(granted.request)).toEqual(['respond']);expect(()=>assertTaskActionPermissions(['respond'],{granted_permissions:['supervise']})).toThrow('forbidden');
  const result=await host.handle(granted,async()=>new Date(s.clock()+10000).toISOString());expect(result.response.type).toBe('response');expect(s.counts().mutations).toBe(1);
  s.source.action=async()=>{throw {message:'stale_revision'};};
  const stale=await host.handle(s.delivery('conversation.action',{ref:s.ref,expected_revision:1,idempotency_key:'native-stale',action:'pin'}),async()=>new Date(s.clock()+10000).toISOString());expect(stale.response).toMatchObject({type:'error',code:'stale_revision'});
  s.source.action=async()=>{throw {message:'synthetic-private-provider-payload'};};
  const safe=await host.handle(s.delivery('conversation.create',{instance_id:'instance',idempotency_key:'native-private'}),async()=>new Date(s.clock()+10000).toISOString());expect(safe.response).toMatchObject({type:'error',code:'unavailable'});expect(JSON.stringify(safe)).not.toContain('synthetic-private-provider-payload');
  await host.dispose();await expect(host.handle(granted,async()=>new Date(s.clock()+10000).toISOString())).rejects.toThrow('unavailable');
});

test('missing descriptions use only the latest controlled user preview and never a raw assistant snippet',async()=>{
  const s=setup();s.conversations[0].description=null;s.metadata[0].preview_message_id='user-preview';s.messages.push({...message('user-preview',s.ref.conversation_id,'Demande utile avec accents'),role:'user'});
  const cards=()=>s.read('conversations.catalog',{instance_id:'instance',kind:'conversation'}) as Promise<CapturePage<ContentConversationCard>>;
  expect((await cards()).items[0].description).toBe('Demande utile avec accents');expect(s.counts().transcriptReads).toBe(0);
  s.messages[0].content='Visible prefix '+ 'x'.repeat(20000)+' synthetic-secret';expect((await cards()).items[0].description).toBe('');expect(JSON.stringify(await cards())).not.toContain('synthetic-secret');
});


test('backward windows open at the latest page, prepend bounded chronological pages and isolate cursors',async()=>{
  const s=setup();for(let i=0;i<140;i++)s.add(message(`answer-${String(i).padStart(3,'0')}`,s.ref.conversation_id));
  const first=await s.read('conversation.window',{ref:s.ref,direction:'backward'}) as CapturePage<MessageItem>;
  expect(first.page.offset).toBe(90);expect(first.items.length).toBe(50);expect(first.items[49].position).toBe(139);
  const continuation={snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor};
  const next=await s.read('conversation.window',{ref:s.ref,direction:'backward',continuation}) as CapturePage<MessageItem>;
  expect(next.page.offset).toBe(40);expect(next.items[49].position).toBe(89);
  const last=await s.read('conversation.window',{ref:s.ref,direction:'backward',continuation:{snapshot_id:next.page.snapshot_id,cursor:next.page.next_cursor}}) as CapturePage<MessageItem>;
  expect(last.page.offset).toBe(0);expect(last.page.next_cursor).toBeNull();expect(last.items.length).toBe(40);
  expect([...last.items,...next.items,...first.items].map(m=>m.position)).toEqual(Array.from({length:140},(_,i)=>i));
  await expect(s.read('conversation.window',{ref:s.ref,continuation})).rejects.toThrow('validation_failed');
  await expect(s.read('conversation.window',{ref:s.ref,direction:'backward',continuation},'other')).rejects.toThrow('validation_failed');
  const legacy=await s.read('conversation.window',{ref:s.ref}) as CapturePage<MessageItem>;
  expect(legacy.page.offset).toBe(0);expect(legacy.items[0].position).toBe(0);
  const targeted=await s.read('conversation.window',{ref:s.ref,direction:'backward',message_id:'answer-020'}) as CapturePage<MessageItem>;
  expect(targeted.items.some(m=>m.message_id==='answer-020')).toBe(true);
  const denied=s.delivery('conversation.window',{ref:s.ref,direction:'backward'});denied.capabilities=['conversations-1'];
  expect(validateMessage(denied).valid).toBe(false);await expect(s.manager.handle(denied,policy,async()=>new Date(s.clock()+10000).toISOString())).rejects.toThrow('validation_failed');
});
test('backward Unicode windows respect the byte limit and contiguous cursor boundaries',async()=>{
  const s=setup();for(let i=0;i<60;i++)s.add(message(`big-${String(i).padStart(3,'0')}`,s.ref.conversation_id,'😀'.repeat(5000)));
  const first=await s.read('conversation.window',{ref:s.ref,direction:'backward'}) as CapturePage<MessageItem>;
  expect(first.items.length).toBeLessThan(50);expect(first.items.at(-1)!.position).toBe(59);expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(240*1024);
  const next=await s.read('conversation.window',{ref:s.ref,direction:'backward',continuation:{snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor}}) as CapturePage<MessageItem>;
  expect(next.page.offset+next.items.length).toBe(first.page.offset);
});

test('send validates the selected conversation revision rather than the catalog revision', async () => {
  const s = setup(2);
  s.metadata[0].revision = 7;
  const controller = new AbortController();
  const host = new ContentHost({accountId:'account', instanceId:'instance', signal:controller.signal,
    conversations:s.captures, conversationManagement:s.manager, storage:memory(),
    reviews:createReviewCaptureService(), reviewRefs:async()=>[], resolveReview:async()=>{throw new Error('not_found');},
    commitReview:async()=>false, policy:async()=>policy, now:s.clock});
  await host.initialize();
  await host.validateConversationSendTarget(s.ref, 7);
  s.metadata[1].revision = 12;
  await host.validateConversationSendTarget(s.ref, 7);
  s.metadata[0].revision = 8;
  await expect(host.validateConversationSendTarget(s.ref, 7)).rejects.toThrow('stale_revision');
  await expect(host.validateConversationSendTarget({...s.ref, conversation_id:'absent'}, 8)).rejects.toThrow('invalid_reference');
  await host.dispose();
});

test('window revisions follow their native transcript rather than the catalog counter', async () => {
  const s = setup();
  for (let i = 0; i < 4; i++) {
    s.add(message(`revision-${i}`, s.ref.conversation_id));
    await s.captures.conversationRead({accountId:'account',sessionId:'session',instanceId:'instance',reliability:true}, s.ref);
  }
  const catalog = await s.read('conversations.catalog', {instance_id:'instance',kind:'conversation'}) as CapturePage<ContentConversationCard>;
  const card = catalog.items[0];
  expect(card.content_revision).toBeGreaterThan(catalog.page.revision);
  const window = await s.read('conversation.window', {ref:s.ref,direction:'backward'}) as CapturePage<MessageItem>;
  expect(window.page.revision).toBe(card.content_revision);
  expect(window.items).toHaveLength(4);
});

for (const operation of ['conversations.catalog', 'conversations.search', 'conversation.window'] as const) test(`rechecks a prepared management page before emission: ${operation}`, async () => {
  const s = setup(); s.add(message('answer', s.ref.conversation_id));
  const body = operation === 'conversation.window' ? { ref: s.ref } : { instance_id: 'instance', kind: 'conversation', ...(operation === 'conversations.search' ? { query: 'cafe' } : {}) };
  const delivery = s.delivery(operation, body);
  const result = await s.manager.handle(delivery, policy, async () => new Date(s.clock() + 9000).toISOString());
  await s.manager.validateEmission(delivery, result, policy);
  if (operation === 'conversation.window') s.messages[0].content = 'Changed observed response';
  else s.conversations[0].title = 'Changed card title';
  await expect(s.manager.validateEmission(delivery, result, policy)).rejects.toThrow('stale_revision');
  s.clear();
  await expect(s.manager.validateEmission(delivery, result, policy)).rejects.toThrow('snapshot_expired');
});
