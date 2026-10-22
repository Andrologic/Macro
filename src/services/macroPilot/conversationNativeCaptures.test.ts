import { expect, test } from 'bun:test';
import { ConversationCaptures, type CaptureDependencies, type NativeCapturePage, type ConversationRef, type ConversationActivity } from './conversationCaptures';
import { ConversationManager, type ConversationManagementSource } from './conversationManager';
import { ContentHost } from './contentHost';
import { createReviewCaptureService } from './reviewCapture';
import type { ContentDelivery, ContentRequest } from './contentProtocol';
import type { ConversationContentItem, ConversationContentMetadataPage } from '../ipc/conversationContent';
import type { DbConversation } from '../tauriIpc';
import { utf8Bytes } from './conversationText';
const date = '2026-01-01T00:00:00Z';
const scope = { accountId:'account', sessionId:'session', instanceId:'instance', reliability:true };
const ref: ConversationRef = { instance_id:'instance', kind:'conversation', conversation_id:'chat' };
const memory = (initial: string|null = null) => { let value = initial; return { load: async()=>value, compareAndSwap: async(before:string|null,next:string)=>{if(before!==value)return false;value=next;return true;}, get value(){return value;} }; };
function setup(count = 140, quota = 8*1024*1024, storage = memory()) {
  let clock = Date.parse(date); let revision = 1n; let req = 0; let metadataReads = 0; let versions = 0; let legacy = 0; let maxPrefix = 100;
  let policy = { revision:'visible-1', secrets:[] as string[] };
  let runtime: ConversationActivity = {activity:'idle',generatingMessageId:null};
  const conversation: DbConversation = {id:'chat',title:'Synthetic',description:null,scope_mode:'Chat',project_id:null,task_id:null,group_id:null,provider_id:null,model_id:null,reasoning_effort:null,created_at:date,updated_at:date,last_message:null,message_count:count,is_pinned:false};
  const conversations = [conversation];
  const rows: ConversationContentItem[] = Array.from({length:count},(_,i)=>({id:`m${String(i).padStart(5,'0')}`,conversation_id:'chat',role:i%2?'assistant':'user',content:i%2?'<think>private</think>Final':'Sent',created_at:date,completion_reason:'completed',tool_traces_json:null,provider_turn_state_json:null,provenance_json:null,response_revision_decimal:i%2?String(i+1):null}));
  const batches: string[][] = []; const acknowledged: number[][] = [];
  const token = ()=>({version:1,incarnation:'a'.repeat(32),revision:String(revision)});
  const same = (value: unknown)=>JSON.stringify(value)===JSON.stringify(token());
  const forbidden = async():Promise<never>=>{legacy++;throw new Error('legacy called');};
  const source: ConversationManagementSource = {
    projects:async()=>[],tasks:async()=>[],listConversations:async()=>structuredClone(conversations),getConversation:forbidden,listMessages:forbidden,metadata:forbidden,catalogMetadata:forbidden,message:forbidden,responseVersion:forbidden,
    activity:()=>({activity:'busy',generatingMessageId:null}),runtimeActivity:()=>structuredClone(runtime),search:forbidden,action:forbidden,synchronize:async()=>{},acknowledge:async(_id,observed)=>{acknowledged.push(observed);},
    nativeContent:{
      version:async()=>{versions++;return token();},
      metadata:async input=>{
        metadataReads++; if(input.expected_token&&!same(input.expected_token))throw new Error('stale_revision');
        const all = rows.map(({id,conversation_id,role,created_at})=>({id,conversation_id,role,created_at})).sort((a,b)=>a.created_at<b.created_at?-1:a.created_at>b.created_at?1:a.id<b.id?-1:1);
        const start = input.after ? all.findIndex(d=>d.id===input.after!.id&&d.created_at===input.after!.created_at)+1:0;
        const items = all.slice(start,start+input.limit);
        const last = items.at(-1);
        const page: ConversationContentMetadataPage = { token:token(),items,next_after:start+items.length<all.length&&last?{id:last.id,created_at:last.created_at}:null,admission_estimate_bytes:4096+utf8Bytes(JSON.stringify(items))*6 };
        if(!input.after)page.opening={total_raw:String(rows.length),total_exportable:String(rows.filter(r=>r.role==='user'||r.role==='assistant').length),conversation:structuredClone(conversation),metadata:{conversation_id:'chat',revision:'1',archived:false,response_revision:'0',read_revision:'0',pending_tool:false,provider_failed:false,question_message_id:null,preview_message_id:null}};
        return page;
      },
      window:async input=>{
        if(!same(input.expected_token))throw new Error('stale_revision');
        batches.push([...input.ids]);
        const selected: ConversationContentItem[]=[];let bytes=4096;
        for(const id of input.ids.slice(0,maxPrefix)){const row=rows.find(r=>r.id===id)!;const size=utf8Bytes(JSON.stringify(row))*6+2048;if(bytes+size>4194304){if(!selected.length)throw new Error('resource_limit');break;}bytes+=size;selected.push(structuredClone(row));}
        return {token:token(),items:selected,consumed_count:selected.length,admission_estimate_bytes:bytes};
      },
    },
  };
  const deps: CaptureDependencies={instanceId:'instance',workspaceId:'workspace',source,storage,policy:()=>policy,now:()=>clock,quotaBytes:quota};
  const captures=new ConversationCaptures(deps);
  const manager=new ConversationManager({instanceId:'instance',source,captures,storage:memory(),now:()=>clock});
  const delivery=(body:unknown,operation='conversation.window'):ContentDelivery=>({transport_version:'2.0',type:'delivery',request_id:`request-${++req}`,instance_id:'instance',account_id:'account',source_session_id:'session',expires_at:new Date(clock+300000).toISOString(),capabilities:['conversations-1','conversation-history-1'],request:{contract_version:'2.0',type:'request',request_id:`request-${req}`,account_id:'account',operation,body} as ContentRequest});
  const read=async(body:unknown={ref})=>manager.handle(delivery(body),policy,async()=>new Date(clock+10000).toISOString()) as Promise<NativeCapturePage & {read_token:string|null}>;
  return {source,deps,captures,manager,rows,storage,batches,acknowledged,delivery,read,policy:()=>policy,clock:()=>clock,setPolicy:(secrets:string[])=>{policy={revision:'visible-1',secrets};},setRuntime:(value:ConversationActivity)=>{runtime=value;},setRevision:(value:bigint)=>{revision=value;},bump:()=>revision++,expire:()=>{clock+=300000;},prefix:(n:number)=>{maxPrefix=n;},counts:()=>({metadataReads,versions,legacy})};
}
const continuation=(page:NativeCapturePage)=>({snapshot_id:page.page.snapshot_id,cursor:page.page.next_cursor!});

test('real manager and ContentHost traverse 10,000 small rows with only candidate batches and no legacy reads',async()=>{
  const s=setup(10000);const host=new ContentHost({accountId:'account',instanceId:'instance',signal:new AbortController().signal,conversations:s.captures,conversationManagement:s.manager,storage:memory(),reviews:createReviewCaptureService(),reviewRefs:async()=>[],resolveReview:async()=>{throw new Error('not_found');},commitReview:async()=>false,policy:async()=>s.policy(),now:s.clock});await host.initialize();
  const d=s.delivery({ref});const response=await host.handle(d,async()=>new Date(s.clock()+10000).toISOString());expect(response.response.type).toBe('response');
  let page=(response.response as unknown as {result:NativeCapturePage}).result;
  expect(page.items).toHaveLength(50);expect(s.batches).toHaveLength(1);expect(s.batches[0]).toHaveLength(50);expect(s.counts().metadataReads).toBe(100);
  const before=s.counts();await host.validateConversationEmission(d,response);expect(s.counts().metadataReads).toBe(before.metadataReads);expect(s.batches).toHaveLength(1);expect(s.counts().versions).toBeGreaterThan(before.versions);
  const positions=page.items.map(i=>i.position);
  while(page.page.next_cursor){page=await s.read({ref,continuation:continuation(page)});positions.push(...page.items.map(i=>i.position));}
  expect(positions).toEqual(Array.from({length:10000},(_,i)=>i));expect(s.counts().legacy).toBe(0);expect(s.counts().metadataReads).toBe(100);expect(s.batches.every(b=>b.length<=50)).toBe(true);
  expect((s.captures as unknown as {captures:Map<string,{native:{page:unknown};items:unknown[]}>}).captures.values().next().value?.items).toEqual([]);
  await host.dispose();
},30000);

test('backward, anchored jump and replay after page eviction keep exact boundaries with variable native prefixes',async()=>{
  const s=setup();s.prefix(7);
  const first=await s.read({ref,direction:'backward'});expect(first.page.offset).toBe(90);expect(first.items.at(-1)!.position).toBe(139);
  const input={ref,direction:'backward',continuation:continuation(first)};
  const second=await s.read(input);expect(second.page.offset).toBe(40);
  await s.read({ref,direction:'backward',continuation:continuation(second)});
  const replay=await s.read(input);expect(replay.page).toEqual(second.page);expect(replay.items).toEqual(second.items);
  for(const direction of ['forward','backward']){const page=await s.read({ref,message_id:'m00070',...(direction==='backward'?{direction}:{})});expect(page.page.offset).toBe(direction==='backward'?26:65);expect(page.items).toHaveLength(50);expect(page.items.some(i=>i.message_id==='m00070')).toBe(true);}
});

test('byte cut keeps one bounded suffix and cache state never changes exact public boundaries',async()=>{
  const s=setup(140);for(const row of s.rows){row.role='user';row.content='\u0001'.repeat(16384);}
  const first=await s.captures.conversationRead(scope,ref,undefined,50);expect(first.items).toHaveLength(2);expect(s.batches[0]).toHaveLength(50);
  const c={snapshot_id:first.page.snapshot_id,cursor:first.page.next_cursor!};
  const second=await s.captures.conversationRead(scope,ref,c,3);expect(second.items.map(i=>i.position)).toEqual([2,3]);
  await s.captures.conversationRead(scope,ref,{snapshot_id:second.page.snapshot_id,cursor:second.page.next_cursor!},1);
  const replay=await s.captures.conversationRead(scope,ref,c,3);expect(replay).toEqual(second);expect(s.counts().legacy).toBe(0);
  expect(utf8Bytes(JSON.stringify(replay))).toBeLessThan(240*1024);
});

test('only rendered complete assistants create tickets, missing or unsafe decimal revisions fail explicitly',async()=>{
  const s=setup(60);const first=await s.read();expect(first.read_token).toBeString();
  await s.source.acknowledge('chat',[],undefined);
  // Access ticket values through the real acknowledgement path without a cards read.
  await s.manager.handle(s.delivery({ref,read_token:first.read_token},'conversation.acknowledge'),s.policy(),async()=>new Date(s.clock()+10000).toISOString());
  expect(s.acknowledged.at(-1)).toEqual(Array.from({length:25},(_,i)=>i*2+2));
  const absent=setup(2);absent.rows[1].response_revision_decimal=null;await expect(absent.read()).rejects.toThrow('unavailable');
  const large=setup(2);large.rows[1].response_revision_decimal='9007199254740993';await expect(large.read()).rejects.toThrow('resource_limit');
  const withheld=setup(2);withheld.rows[1].content='unknown';withheld.rows[1].response_revision_decimal=null;expect((await withheld.read()).read_token).toBeNull();
});

test('native failures never fall back; final guards cover token, real policy, runtime and absolute expiry',async()=>{
  for(const dimension of ['token','policy','runtime','expiry'] as const){const s=setup(4);const d=s.delivery({ref});const page=await s.manager.handle(d,s.policy(),async()=>date);if(dimension==='token')s.bump();if(dimension==='policy')s.setPolicy(['changed']);if(dimension==='runtime')s.setRuntime({activity:'busy',generatingMessageId:'m00001'});if(dimension==='expiry')s.expire();await expect(s.manager.validateEmission(d,page,s.policy())).rejects.toThrow();expect(s.counts().legacy).toBe(0);}
  const s=setup();s.source.nativeContent!.window=async()=>{throw new Error('unavailable');};await expect(s.read()).rejects.toThrow('unavailable');expect(s.counts().legacy).toBe(0);
});

test('metadata-only observations preserve content; old clocks migrate monotonically across epoch and recreation',async()=>{
  const s=setup(4);const first=await s.captures.conversationRead(scope,ref);const before=JSON.parse(s.storage.value!);await s.captures.refreshCatalogMetadata(true);expect(JSON.parse(s.storage.value!).resources).toEqual(before.resources);
  const restart=new ConversationCaptures(s.deps);const next=await restart.conversationRead(scope,ref);expect(next.page.revision).toBeGreaterThan(first.page.revision);
  const old=JSON.parse(s.storage.value!);old.version=3;for(const record of Object.values(old.resources) as Array<Record<string,unknown>>){delete record.content;record.revision=700;}old.conversations.revision=500;await s.storage.compareAndSwap(s.storage.value,JSON.stringify(old));
  const migrated=await new ConversationCaptures(s.deps).conversationRead(scope,ref);expect(migrated.page.revision).toBe(701);
  s.captures.clear();await expect(s.captures.conversationRead(scope,ref,{snapshot_id:first.page.snapshot_id,cursor:'old'})).rejects.toThrow('snapshot_expired');
});

test('all roles are validated before filtering and unrequested huge bodies never block a page',async()=>{
  const s=setup(80);s.rows[79].content='x'.repeat(5000000);await s.read();expect(s.batches.flat()).not.toContain(s.rows[79].id);
  const invalid=setup(4);invalid.rows[3].role='tool';invalid.rows[3].created_at='invalid';await expect(invalid.read()).rejects.toThrow('content_unavailable');expect(invalid.batches).toEqual([]);
  const duplicate=setup(4);duplicate.rows[3].id=duplicate.rows[0].id;await expect(duplicate.read()).rejects.toThrow('content_unavailable');
});

function owned(s:ReturnType<typeof setup>){return s.captures as unknown as {captures:Map<string,{bytes:number;native:{pending?:{bytes:number};page?:unknown}}>;reservations:Map<symbol,number>};}
function barrier(){let release!:()=>void;let arrived!:()=>void;const reached=new Promise<void>(r=>{arrived=r;});const held=new Promise<void>(r=>{release=r;});return {reached,release,wait:async()=>{arrived();await held;}};}

test('delayed old-epoch body completion releases only its own reservation and permits a clean new capture',async()=>{
  const s=setup(4);const original=s.source.nativeContent!.window;const gate=barrier();let once=true;
  s.source.nativeContent!.window=async input=>{const result=await original(input);if(once){once=false;await gate.wait();}return result;};
  const old=s.captures.conversationRead(scope,ref);await gate.reached;expect(owned(s).reservations.size).toBeGreaterThan(0);
  s.captures.clear();const fresh=s.captures.conversationRead(scope,ref);gate.release();await expect(old).rejects.toThrow('unavailable');expect((await fresh).items).toHaveLength(4);expect(owned(s).captures.size).toBe(1);expect(owned(s).reservations.size).toBe(0);
});

test('a native refusal after a partial prefix aborts the entire page and releases all fragments',async()=>{
  const s=setup(60);s.prefix(1);s.rows[1].content='x'.repeat(5000000);
  await expect(s.read()).rejects.toThrow('resource_limit');expect(s.batches.map(b=>b.length)).toEqual([50,49]);expect(owned(s).captures.size).toBe(0);expect(owned(s).reservations.size).toBe(0);
  s.rows[1].content='<think>private</think>Final';expect((await s.read()).items).toHaveLength(50);
});

test('quota reservations fail explicitly without shortening pages or leaving buffers and tickets',async()=>{
  const small=setup(60,4*1024*1024+4096);await expect(small.read()).rejects.toThrow('resource_limit');expect(small.batches).toHaveLength(0);expect(owned(small).captures.size).toBe(0);expect(owned(small).reservations.size).toBe(0);
  const s=setup(2);s.rows[1].response_revision_decimal='9007199254740993';await expect(s.read()).rejects.toThrow('resource_limit');expect(owned(s).captures.size).toBe(0);expect((s.manager as unknown as {tickets:Map<string,unknown>;snapshots:Map<string,unknown>}).tickets.size).toBe(0);expect((s.manager as unknown as {snapshots:Map<string,unknown>}).snapshots.size).toBe(0);
});

test('retained host response is rejected after token change without body or descriptor reloading',async()=>{
  const s=setup(4);const host=new ContentHost({accountId:'account',instanceId:'instance',signal:new AbortController().signal,conversations:s.captures,conversationManagement:s.manager,storage:memory(),reviews:createReviewCaptureService(),reviewRefs:async()=>[],resolveReview:async()=>{throw new Error('not_found');},commitReview:async()=>false,policy:async()=>s.policy(),now:s.clock});await host.initialize();
  const d=s.delivery({ref});const response=await host.handle(d,async()=>new Date(s.clock()+10000).toISOString());const before=s.counts();const batches=s.batches.length;s.bump();await expect(host.validateConversationEmission(d,response)).rejects.toThrow('stale_revision');expect(s.counts().metadataReads).toBe(before.metadataReads);expect(s.batches).toHaveLength(batches);await host.dispose();
});

test('catalogue retries once under a new token and dates retain TS ordering across SQL binary traversal',async()=>{
  const s=setup(4);s.rows[0].created_at='2026-01-01T00:00:00+01:00';s.rows[1].created_at='2026-01-01T00:00:00-01:00';
  const original=s.source.nativeContent!.metadata;let calls=0;s.source.nativeContent!.metadata=async input=>{if(calls++===0){s.bump();throw new Error('stale_revision');}return original(input);};
  const page=await s.read();const expected=[...s.rows].sort((a,b)=>a.created_at.localeCompare(b.created_at)||(a.id<b.id?-1:1)).map(r=>r.id);expect(page.items.map(i=>i.message_id)).toEqual(expected);expect(calls).toBe(2);
});

test('CAS loss rereads winning clocks; nonvisited content and deletion/recreation stay monotone',async()=>{
  const s=setup(4);await s.read();const before=JSON.parse(s.storage.value!);const original=s.deps.storage.compareAndSwap;let lost=false;
  s.deps.storage.compareAndSwap=async(prev,next)=>{if(!lost){lost=true;const winner=JSON.parse(prev!);winner.conversations.revision=800;for(const r of Object.values(winner.resources) as Array<{revision:number}>)r.revision=800;await original(prev,JSON.stringify(winner));return false;}return original(prev,next);};
  s.bump();const page=await new ConversationCaptures(s.deps).conversationRead(scope,ref);expect(page.page.revision).toBe(801);expect(JSON.parse(s.storage.value!).version).toBe(4);expect(before.resources).not.toEqual(JSON.parse(s.storage.value!).resources);
  const present=s.source.listConversations;s.source.listConversations=async()=>[];const removed=await s.captures.refreshCatalogMetadata(true);expect(removed.revision).toBeGreaterThan(801);
  s.source.listConversations=present;const recreated=await s.captures.conversationRead(scope,ref);expect(recreated.page.revision).toBeGreaterThan(removed.revision);
});

test('partial declared ports and malformed journal variants fail without legacy fallback',async()=>{
  const partial=setup(2);partial.source.nativeContent={version:partial.source.nativeContent!.version} as typeof partial.source.nativeContent;expect(()=>new ConversationCaptures(partial.deps)).toThrow('unavailable');
  for(const content of [{kind:'native',source_epoch:'old',token:{version:1,incarnation:'x',revision:'1'}},{kind:'other',hash:'x'}]){const s=setup(2);await s.read();const journal=JSON.parse(s.storage.value!);Object.values(journal.resources).forEach(record=>{(record as {content:unknown}).content=content;});await s.storage.compareAndSwap(s.storage.value,JSON.stringify(journal));await expect(s.captures.refreshCatalogMetadata()).rejects.toThrow('unavailable');expect(s.counts().legacy).toBe(0);}
});

test('pure snapshot provenance keeps UTF-16 ranges and vetoes contradictory provider evidence',async()=>{
  const s=setup(2);const content='<think>private</think>🙂 Final';s.rows[1].content=content;
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([s.rows[1].id,content])))),byte=>byte.toString(16).padStart(2,'0')).join('');
  s.rows[1].provenance_json=JSON.stringify({version:2,source:'provider-output',fingerprint,start:content.indexOf('🙂'),end:content.length});
  expect((await s.read()).items[1]).toMatchObject({text:'🙂 Final',content_state:'complete'});
  s.rows[1].provider_turn_state_json='{}';s.bump();expect((await s.read()).items[1].content_state).toBe('withheld');expect(s.counts().legacy).toBe(0);
});


test('project and task dimensions are revalidated independently of the native token',async()=>{
  for(const dimension of ['projects','tasks'] as const){const s=setup(4);const d=s.delivery({ref});const page=await s.manager.handle(d,s.policy(),async()=>date);if(dimension==='projects')s.source.projects=async()=>[{id:'added',name:'Added'}];else s.source.tasks=async()=>[{id:'new-task',project_id:'added'}];await expect(s.manager.validateEmission(d,page,s.policy())).rejects.toThrow('stale_revision');expect(s.counts().legacy).toBe(0);}
});

test('both desktop factories expose the registered IPC trio and management bypasses its persisted-attention cache',async()=>{
  const {desktopConversationCaptureSource,desktopConversationManagementSource}=await import('./conversationCaptureSource');
  const s=setup(4);const prior=Object.getOwnPropertyDescriptor(globalThis,'window');const commands:string[]=[];
  const invoke=async(command:string,args:Record<string,unknown>={})=>{
    commands.push(command);
    if(command==='db_list_conversations')return s.source.listConversations();
    if(command==='db_conversation_content_version')return s.source.nativeContent!.version(args.conversationId as string);
    if(command==='db_conversation_content_metadata')return s.source.nativeContent!.metadata(args.input as Parameters<NonNullable<typeof s.source.nativeContent>['metadata']>[0]);
    if(command==='db_conversation_content_window')return s.source.nativeContent!.window(args.input as Parameters<NonNullable<typeof s.source.nativeContent>['window']>[0]);
    throw new Error(`unexpected native command ${command}`);
  };
  Object.defineProperty(globalThis,'window',{configurable:true,value:{__TAURI_INTERNALS__:{invoke}}});
  try{
    const ports={app:()=>({standaloneProjects:[],projectGroups:[]}),tasks:()=>({tasks:[]}),chat:()=>({conversationRuntimeById:{},pendingToolApprovalByConversationId:{}})} as unknown as import('./desktopStorePorts').DesktopStorePorts;
    for(const source of [desktopConversationCaptureSource(ports),desktopConversationManagementSource(ports)]){
      const captures=new ConversationCaptures({...s.deps,source,storage:memory()});expect((await captures.conversationRead(scope,ref)).items).toHaveLength(4);
      expect(source.nativeContent).toBeDefined();
    }
    expect(commands).toContain('db_conversation_content_metadata');expect(commands).toContain('db_conversation_content_window');expect(commands.every(c=>['db_list_conversations','db_conversation_content_version','db_conversation_content_metadata','db_conversation_content_window'].includes(c))).toBe(true);
  }finally{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');}
});

test('two independent owners sharing a namespace preserve CAS safety under deterministic overlap',async()=>{
  const backing=memory();const s=setup(4);const advances:number[]=[];let arrivals=0;let release!:()=>void;const together=new Promise<void>(r=>{release=r;});
  const storage={load:async()=>{const before=await backing.load();if(++arrivals<=2){if(arrivals===2)release();await together;}return before;},compareAndSwap:async(before:string|null,next:string)=>{const applied=await backing.compareAndSwap(before,next);if(applied)advances.push(JSON.parse(next).conversations.revision);return applied;}};
  const a=new ConversationCaptures({...s.deps,storage});const b=new ConversationCaptures({...s.deps,storage});
  const results=await Promise.allSettled([a.conversationRead(scope,ref),b.conversationRead(scope,ref)]);
  for(const result of results){if(result.status==='fulfilled')expect(result.value.items).toHaveLength(4);else expect(['stale_revision','content_unavailable']).toContain(result.reason.message);}
  expect(advances.length).toBeGreaterThan(1);for(let i=1;i<advances.length;i++)expect(advances[i]).toBeGreaterThanOrEqual(advances[i-1]);
  const previous=advances.at(-1)!;const fresh=await new ConversationCaptures({...s.deps,storage}).conversationRead(scope,ref);expect(fresh.page.revision).toBeGreaterThan(previous);
});

test('unsafe public clock overflow refuses publication and retains the winning journal',async()=>{
  const s=setup(2);await s.read();const journal=JSON.parse(s.storage.value!);journal.conversations.revision=Number.MAX_SAFE_INTEGER;for(const record of Object.values(journal.resources) as Array<{revision:number}>)record.revision=Number.MAX_SAFE_INTEGER;await s.storage.compareAndSwap(s.storage.value,JSON.stringify(journal));const before=s.storage.value;s.bump();await expect(s.read()).rejects.toThrow('resource_limit');expect(s.storage.value).toBe(before);
});


test('cumulative retained catalogues respect 8 MiB independently of the 24 MiB owner and release cleanly',async()=>{
  const small=setup(2000,8*1024*1024);let accepted=0;
  for(;accepted<20;accepted++){try{expect((await small.captures.conversationRead(scope,ref)).items).toHaveLength(100);}catch(error){expect((error as Error).message).toBe('resource_limit');break;}}
  expect(accepted).toBeGreaterThan(1);expect(accepted).toBeLessThan(20);expect(owned(small).captures.size).toBe(accepted);expect(owned(small).reservations.size).toBe(0);
  const large=setup(2000,24*1024*1024);for(let i=0;i<=accepted;i++)expect((await large.captures.conversationRead(scope,ref)).items).toHaveLength(100);
  small.captures.clear();expect(owned(small).captures.size).toBe(0);expect((await small.captures.conversationRead(scope,ref)).items).toHaveLength(100);large.captures.clear();
});

test('token decimals above 2^53 stay exact while unsafe public totals refuse before bodies',async()=>{
  const s=setup(2);s.setRevision(9007199254740993n);const page=await s.captures.conversationWindow(scope,ref);expect(page.contentToken.revision).toBe('9007199254740993');
  const oversized=setup(2);const original=oversized.source.nativeContent!.metadata;oversized.source.nativeContent!.metadata=async input=>{const page=await original(input);if(page.opening)page.opening.total_raw='9007199254740993';return page;};await expect(oversized.read()).rejects.toThrow('resource_limit');expect(oversized.batches).toHaveLength(0);
});
