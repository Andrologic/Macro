import { describe, expect, it } from 'bun:test';
import { admitReadAuthority, captureDeadline, capabilityCompatibilityError } from './readAuthority';
import { PilotTargetClient } from './targetClient';
import { ConsumerReader } from './consumerReader';
import { PilotClientError } from './clientError';
import type { ConsumerIdentity } from './consumerTransport';
import type { PilotInstanceAccess } from './nativeClient';
import type { ContentPage, ContentReadAuthority, ContentConversationCard } from './contentProtocol';
import { createConnectConsumerFixture } from '../../../dev/fixtures/connectConsumer';
import { connectReaderRetry } from '../../composition/macroConnectConsumer';

const wall = Date.parse('2026-01-01T00:00:00Z');
const observation = { deviceId: 'device:synthetic', sessionRevision: 0 };
const gate = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function manualClock() {
  let now=0; const timers=new Map<object,{at:number;run():void}>();
  return {now:()=>now,timer:(run:()=>void,ms:number)=> { const key={}; timers.set(key,{at:now+ms,run}); return ()=> { timers.delete(key); }; },
    advance:(ms:number)=> { now+=ms; for(const [key,value] of [...timers]) if(value.at<=now) { timers.delete(key); value.run(); } }, count:()=>timers.size};
}
const until = async (check: () => boolean) => { const end=Date.now()+4000; while (!check() && Date.now()<end) await new Promise(r=>setTimeout(r,2)); expect(check()).toBe(true); };
function target(lifetime = 30000) {
  let now = 0;
  const h = createConnectConsumerFixture({ authorityLifetimeMs: lifetime, monotonicNow: () => now });
  const client = new PilotTargetClient(h.transport, 'instance:alpha', { session: observation,
    access: h.access('instance:alpha') as PilotInstanceAccess, monotonic: () => now });
  return { h, client, setNow: (value: number) => { now=value; } };
}
const proof = (identity: ConsumerIdentity, duration=30000): ContentReadAuthority => ({
  authority_binding:'binding:synthetic', account_id: identity.accountId, session_id: identity.sessionId, device_id: observation.deviceId,
  instance_id:'instance:alpha', producer_generation:'producer:synthetic', session_revision:0, access_revision:0,
  permissions:['supervise'], issued_at:new Date(wall).toISOString(), expires_at:new Date(wall+duration).toISOString(),
});
describe('read-authority exact deadlines and admission', () => {
  it('consumes the credential/response wait, closes at equality and accepts one millisecond', () => {
    const h=createConnectConsumerFixture(), identity=h.transport.context();
    expect(admitReadAuthority(proof(identity,1),identity,observation,'instance:alpha',0,100,100).deadline).toBe(101);
    expect(()=>admitReadAuthority(proof(identity),identity,observation,'instance:alpha',0,100,30100)).toThrow('invalid_response');
    expect(()=>admitReadAuthority(proof(identity),identity,observation,'instance:alpha',0,100,30101)).toThrow('invalid_response');
  });
  it('uses the original request and authenticated issuance to shorten a capture despite a late local UTC', () => {
    const h=createConnectConsumerFixture(), p=proof(h.transport.context());
    const authority=admitReadAuthority(p,h.transport.context(),observation,'instance:alpha',0,0,10);
    const page={observed_at:new Date(wall).toISOString(), expires_at:new Date(wall+120000).toISOString()} as ContentPage;
    expect(captureDeadline(page,{monotonic:10000,wall:wall-3600000},authority)).toBe(120000);
    expect(captureDeadline(page,{monotonic:20000,wall},authority,90000)).toBe(90000);
    expect(captureDeadline(page,{monotonic:20000,wall:wall+119000},authority)).toBe(21000);
  });
  it.each(['account_id','session_id','device_id','instance_id','authority_binding','producer_generation'] as const)('rejects changed %s and never borrows a local generation', key => {
    const h=createConnectConsumerFixture(), identity=h.transport.context(), p=proof(identity);
    const before=admitReadAuthority(p,identity,observation,'instance:alpha',0,0,0);
    expect(()=>admitReadAuthority({...p,[key]:'replacement:synthetic'},identity,observation,'instance:alpha',0,100,100,before)).toThrow();
  });
  it.each(['session_revision','access_revision'] as const)('requires exact %s and accepts zero', key => {
    const h=createConnectConsumerFixture(), identity=h.transport.context();
    expect(()=>admitReadAuthority({...proof(identity),[key]:1},identity,observation,'instance:alpha',0,0,0)).toThrow('invalid_response');
  });
  it('admits only closed, correlated v1 negotiation compatibility errors', () => {
    const body={contract_version:'1.0',type:'error',request_id:'request:synthetic',error:{code:'validation_failed',message:'Synthetic rejection',retryable:false}};
    expect(capabilityCompatibilityError(400,'request:synthetic','request:synthetic',body)).not.toBeNull();
    for(const status of [401,403,422,503]) expect(capabilityCompatibilityError(status,'request:synthetic','request:synthetic',body)).toBeNull();
    expect(capabilityCompatibilityError(400,null,'request:synthetic',body)).toBeNull();
    expect(capabilityCompatibilityError(400,'request:other','request:synthetic',body)).toBeNull();
    expect(capabilityCompatibilityError(400,'request:synthetic','request:synthetic',{...body,unexpected:true})).toBeNull();
    expect(capabilityCompatibilityError(400,'request:synthetic','request:synthetic',{...body,request_id:'request:other'})).toBeNull();
  });
});
describe('real target renewal races on a synthetic credential port', () => {
  it('preserves scope/cursor and capture deadlines through repeated healthy renewals with no reset or read', async () => {
    const {h,client,setNow}=target();
    try {
      await client.negotiate(); const events=await client.events(); client.acknowledgeEvents(events);
      const page=await client.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation',filter:{mode:'Chat',archived:'active'}});
      const scope=client.scope(), count=h.calls.filter(c=>c.dispatch.kind==='submit').length;
      setNow(15000); await client.renew(); setNow(30000); await client.renew();
      expect(client.scope()).toEqual(scope); expect(page.captureDeadline).toBeLessThanOrEqual(300000);
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(count);
      const feed=client.events(); await until(()=>h.waiting.has('instance:alpha')); h.emit('instance:alpha',[]); client.acknowledgeEvents(await feed);
      const last=h.calls.at(-1)!.dispatch; expect(last.kind).toBe('events'); if(last.kind==='events') expect(last.request.stream_id).toBe(events.page.stream_id);
    } finally { client.dispose(); }
  });
  it('allows a current late renewal after simple expiry but rejects a retired one after suspension', async () => {
    const {h,client,setNow}=target(), delayed=gate<unknown>();
    try {
      await client.negotiate(); const generation=client.scope().generation;
      h.negotiate(async (id,dispatch)=> { const result=h.negotiated(id,dispatch); await delayed.promise; return result; });
      setNow(15000); const renewal=client.renew(); setNow(31000);
      expect(client.readAuthority()!.deadline).toBe(30000); expect(client.scope().generation).toBe(generation);
      delayed.resolve(undefined); await renewal; expect(client.readAuthority()!.deadline).toBe(45000); expect(client.scope().generation).toBe(generation);
      const suspended=gate<unknown>(); h.negotiate(async (id,dispatch)=> { const response=h.negotiated(id,dispatch); await suspended.promise; return response; });
      setNow(32000); const late=client.renew().catch(e=>e); client.reset(); const retired=client.scope().generation; suspended.resolve(undefined);
      expect(await late).toMatchObject({code:'context_changed'}); expect(client.readAuthority()).toBeUndefined(); expect(client.scope().generation).toBe(retired);
    } finally { delayed.resolve(undefined); client.dispose(); }
  });
  it('retires generation before abort on refusal and cannot readmit an older successful read', async () => {
    const {h,client}=target(), delayed=gate<unknown>();
    try {
      await client.negotiate(); const generation=client.scope().generation; let retiredAtAbort=false;
      h.read(async (id,dispatch,signal)=> { signal.addEventListener('abort',()=> { retiredAtAbort=client.scope().generation>generation && !client.readAuthority(); }); await delayed.promise; return h.terminal(id,dispatch); });
      const reading=client.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation'}).catch(e=>e);
      h.negotiate(async ()=> { throw new PilotClientError('forbidden',403); });
      await expect(client.renew()).rejects.toMatchObject({code:'forbidden'}); delayed.resolve(undefined);
      expect(await reading).toMatchObject({code:'context_changed'}); expect(retiredAtAbort).toBe(true); expect(client.readAuthority()).toBeUndefined();
    } finally { delayed.resolve(undefined); client.dispose(); }
  });
  it('consumes waits before port return and rejects a decreasing or invalid monotonic clock', async () => {
    const {h,client,setNow}=target();
    try {
      h.negotiate(async (id,dispatch)=> { setNow(30000); return h.negotiated(id,dispatch); });
      await expect(client.negotiate()).rejects.toMatchObject({code:'invalid_response'});
      h.negotiate(undefined); setNow(30001); await client.negotiate(); setNow(30000);
      expect(()=>client.readAuthority()).toThrow('context_changed'); expect(client.capabilities()).toEqual([]);
      setNow(NaN); expect(()=>client.readAuthority()).toThrow('context_changed');
    } finally { client.dispose(); }
  });
  it('never reanchors a continuation and does not revive it under a later proof', async () => {
    const {client,setNow}=target();
    try {
      await client.negotiate();
      const first=await client.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation'});
      setNow(1000); await client.renew();
      const next=await client.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation',continuation:{snapshot_id:first.response.result.page.snapshot_id,cursor:first.response.result.page.next_cursor!}}, {previous:first,seenIdentities:new Set(first.response.result.items.map(i=>i.ref.conversation_id))});
      expect(next.captureDeadline).toBeLessThanOrEqual(first.captureDeadline!);
      setNow(first.captureDeadline!); await client.renew();
      await expect(client.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation',continuation:{snapshot_id:next.response.result.page.snapshot_id,cursor:next.response.result.page.next_cursor!}}, {previous:next,seenIdentities:new Set(next.response.result.items.map(i=>i.ref.conversation_id))})).rejects.toMatchObject({code:'snapshot_expired'});
    } finally { client.dispose(); }
  });
});
describe('shared owner and reader B7 presentation', () => {
  it('shares renewal for two readers of Alpha, keeps Beta independent and performs zero content reads/reset on renewal', async () => {
    const clock=manualClock();
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); reader.open('instance:beta');
      await until(()=>reader.getSnapshot().panels.every(p=>p.catalog.page));
      for(const p of reader.getSnapshot().panels) reader.select(p.key,(p.catalog.page!.response.result.items[0] as ContentConversationCard).ref);
      await until(()=>reader.getSnapshot().panels.every(p=>p.detail.page));
      const pages=reader.getSnapshot().panels.map(p=>p.detail.page), submits=h.calls.filter(c=>c.dispatch.kind==='submit').length;
      clock.advance(15000); await until(()=>['instance:alpha','instance:beta'].every(id=>h.calls.filter(c=>c.id===id && c.dispatch.kind==='negotiate').length>=2));
      await new Promise(r=>setTimeout(r,2)); clock.advance(15000); await until(()=>['instance:alpha','instance:beta'].every(id=>h.calls.filter(c=>c.id===id && c.dispatch.kind==='negotiate').length>=3));
      await new Promise(r=>setTimeout(r,2));
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(submits);
      expect(reader.getSnapshot().panels.map(p=>p.detail.page)).toEqual(pages);
      expect(h.owner()!.diagnostics()).toMatchObject({targets:2,subscribers:4,desiredReads:0});
      reader.setAvailable(false); expect(reader.getSnapshot().panels.every(p=>!p.catalog.page && !p.detail.page)).toBe(true);
      await until(()=>h.owner()!.diagnostics().activeReads===0); expect(h.owner()!.diagnostics()).toMatchObject({targets:0,subscribers:0}); expect(clock.count()).toBe(0);
    } finally { reader.dispose(); }
  });
  it('retains private valid captures through authority expiry, then unlocks only after proof and continuity', async () => {
    const clock=manualClock();
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[10,20]}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha');
      await until(()=>Boolean(reader.getSnapshot().panels[0]?.catalog.page));
      const page=reader.getSnapshot().panels[0].catalog.page;
      reader.setTransportOnline(false); expect(reader.getSnapshot().panels[0].catalog.page).toBe(page); expect(reader.getSnapshot().choices).toEqual([]);
      clock.advance(30000); await until(()=>reader.getSnapshot().panels[0].phase==='authority_expired'); expect(reader.getSnapshot().panels[0].catalog.page).toBeNull();
      reader.setTransportOnline(true); await until(()=>h.waiting.has('instance:alpha')); expect(reader.getSnapshot().panels[0].catalog.page).toBeNull();
      h.emit('instance:alpha',[]); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page));
      expect(reader.getSnapshot().panels[0].catalog.page).toBe(page); expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
    } finally { reader.dispose(); }
  });
});

it('stops all B7 attempts after the finite shared recovery episode and keeps the other PC healthy', async () => {
  const clock=manualClock();
  const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[10,20]}}), reader=new ConsumerReader(h.ports);
  try {
    reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); reader.open('instance:beta');
    await until(()=>reader.getSnapshot().panels.every(p=>p.catalog.page));
    const beta=reader.getSnapshot().panels[1].catalog.page;
    h.negotiate(async (id,dispatch)=> { if(id==='instance:alpha') throw new PilotClientError('unavailable',503,true); return h.negotiated(id,dispatch); });
    clock.advance(15000); await until(()=>h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate').length===4);
    await new Promise(r=>setTimeout(r,40)); clock.advance(15000); await new Promise(r=>setTimeout(r,5));
    expect(h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate')).toHaveLength(4);
    expect(h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='events')).toHaveLength(2);
    expect(reader.getSnapshot().panels[0].catalog.page).toBeNull(); expect(reader.getSnapshot().panels[1].catalog.page).toBe(beta);
    expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(2);
  } finally { reader.dispose(); }
});
it('waits for an actual visible panel and cancels shared renewal when its last visible reader leaves', async () => {
  const clock=manualClock();
  const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[10,20]}}), reader=new ConsumerReader(h.ports);
  try {
    reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha',false);
    clock.advance(30000); expect(h.calls).toHaveLength(0);
    const key=reader.getSnapshot().panels[0].key; reader.setPanelVisible(key,true);
    await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page));
    reader.setPanelVisible(key,false); const negotiations=h.calls.filter(c=>c.dispatch.kind==='negotiate').length;
    clock.advance(60000); expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(negotiations);
    reader.setPanelVisible(key,true); await until(()=>h.waiting.has('instance:alpha') && h.calls.filter(c=>c.dispatch.kind==='negotiate').length>negotiations);
    h.emit('instance:alpha',[]); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page));
    expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
  } finally { reader.dispose(); }
});

for(const issue of ['proof-without-capability','capability-without-proof','null-version','precision','too-long','zero-lifetime','unknown-proof-field'] as const) it(`rejects a canonical authority mismatch before publication: ${issue}`, async () => {
  const {h,client}=target();
  try {
    h.negotiate(async (id,dispatch)=> {
      const response: Record<string,unknown>=h.negotiated(id,dispatch);
      const authority=response.read_authority as Record<string,unknown>;
      if(issue==='proof-without-capability') response.capabilities=(response.capabilities as string[]).filter(c=>c!=='read-authority-1');
      if(issue==='capability-without-proof') delete response.read_authority;
      if(issue==='null-version') response.selected_version=null;
      if(issue==='precision') authority.issued_at='2026-01-01T00:00:00.0001Z';
      if(issue==='too-long') authority.expires_at=new Date(Date.parse(String(authority.issued_at))+30001).toISOString();
      if(issue==='zero-lifetime') authority.expires_at=authority.issued_at;
      if(issue==='unknown-proof-field') authority.unexpected=true;
      return response;
    });
    await expect(client.negotiate()).rejects.toMatchObject({code:'invalid_response'}); expect(client.readAuthority()).toBeUndefined();
  } finally { client.dispose(); }
});
it('does not resurrect a capture that expired privately while offline, even after fresh authority and continuity', async () => {
  const clock=manualClock();
  const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[10,20]}}), reader=new ConsumerReader(h.ports);
  h.read(async (id,dispatch)=> { const result=h.terminal(id,dispatch); result.result.page.expires_at=new Date(Date.now()+10000).toISOString(); return result; });
  try {
    reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page));
    reader.setTransportOnline(false); clock.advance(10001); await until(()=>reader.getSnapshot().panels[0].catalog.page===null);
    expect(reader.getSnapshot().panels[0].catalog.error).toBe('snapshot_expired'); reader.setTransportOnline(true);
    await until(()=>h.waiting.has('instance:alpha')); h.emit('instance:alpha',[]); await until(()=>reader.getSnapshot().panels[0].phase==='ready');
    expect(reader.getSnapshot().panels[0].catalog.page).toBeNull(); expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
  } finally { reader.dispose(); }
});
it('purges publication on a credential fence even when all wire account/session/origin IDs are unchanged', async () => {
  const h=createConnectConsumerFixture({authorityLifetimeMs:30000}), reader=new ConsumerReader(h.ports);
  try {
    reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page));
    const identity=h.ports.context(); h.changeCredential();
    expect(h.ports.context().key).toBe(identity.key); expect(reader.getSnapshot()).toMatchObject({phase:'ended',panels:[],choices:[]});
    expect(h.owner()!.diagnostics()).toMatchObject({targets:0,subscribers:0,desiredReads:0}); expect(h.listeners.size).toBe(0);
  } finally { reader.dispose(); }
});
it('charges accepted and terminal polling to the original capture start', async () => {
  let now=0; const h=createConnectConsumerFixture({authorityLifetimeMs:30000}); const send=h.transport.send;
  const expires=new Date(Date.now()+5000).toISOString();
  const transport={...h.transport,send:async (...args: Parameters<typeof send>)=> {
    const dispatch=args[2];
    if(dispatch.kind==='submit') return {status:202,data:{transport_version:'2.0',type:'accepted',request_id:dispatch.request.request_id,exchange_id:dispatch.request.request_id,expires_at:new Date(Date.now()+50000).toISOString()}};
    if(dispatch.kind==='poll') {
      now=6000; const response=h.terminal(args[1],{...dispatch,kind:'submit'}); response.result.page.expires_at=expires; return {status:200,data:response};
    }
    return send(...args);
  }};
  const client=new PilotTargetClient(transport,'instance:alpha',{session:observation,access:h.access('instance:alpha') as PilotInstanceAccess,monotonic:()=>now});
  try {
    await client.negotiate(); await expect(client.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation'})).rejects.toMatchObject({code:'snapshot_expired'});
  } finally { client.dispose(); }
});


describe('shared renewal and visible demand regressions', () => {
  for(const settleDuringBackoff of [false,true]) it(`shares ordinary renewal across feed recovery, settled during backoff: ${settleDuringBackoff}`, async () => {
    const clock=manualClock(), hold=gate<void>();
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[10,20]}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); reader.open('instance:beta');
      await until(()=>reader.getSnapshot().panels.every(p=>p.catalog.page) && h.waiting.size===2);
      const pages=reader.getSnapshot().panels.map(p=>p.catalog.page), before=h.waiting.get('instance:alpha')!.request;
      h.negotiate(async (id,dispatch)=> { const response=h.negotiated(id,dispatch); if(id==='instance:alpha') await hold.promise; return response; });
      clock.advance(15000); await until(()=>h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate').length===2);
      h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true));
      await until(()=>reader.getSnapshot().panels[0].phase==='offline');
      if(settleDuringBackoff) hold.resolve();
      await new Promise(r=>setTimeout(r,70));
      expect(reader.getSnapshot().panels.map(p=>p.catalog.page)).toEqual(pages);
      expect(reader.getSnapshot().panels.map(p=>p.phase)).toEqual(['offline','ready']);
      expect(h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate')).toHaveLength(2);
      hold.resolve(); await until(()=>h.waiting.has('instance:alpha'));
      expect(reader.getSnapshot().panels[0].phase).toBe('offline');
      expect(h.waiting.get('instance:alpha')!.request).toMatchObject({stream_id:before.stream_id,after_sequence:before.after_sequence});
      clock.advance(15000); await until(()=>reader.getSnapshot().panels[0].phase==='authority_expired');
      expect(reader.getSnapshot().panels[0].catalog.page).toBeNull(); expect(reader.getSnapshot().panels[1].catalog.page).toBe(pages[1]);
      h.emit('instance:alpha',[]); await until(()=>reader.getSnapshot().panels[0].phase==='ready');
      expect(reader.getSnapshot().panels.map(p=>p.catalog.page)).toEqual(pages);
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(2);
    } finally { hold.resolve(); reader.dispose(); }
    expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
  it('observes a captured renewal failure during backoff and retries once without purging a valid capture', async () => {
    const clock=manualClock(), hold=gate<void>(); let attempts=0;
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[30,40]}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page) && h.waiting.has('instance:alpha'));
      const page=reader.getSnapshot().panels[0].catalog.page;
      h.negotiate(async (id,dispatch)=> { const response=h.negotiated(id,dispatch); if(++attempts===1) await hold.promise; return response; });
      clock.advance(15000); await until(()=>attempts===1); h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true));
      await until(()=>reader.getSnapshot().panels[0].phase==='offline'); hold.reject(new PilotClientError('unavailable',503,true));
      await until(()=>attempts===2 && h.waiting.has('instance:alpha')); expect(reader.getSnapshot().panels[0].catalog.page).toBe(page);
      h.emit('instance:alpha',[]); await until(()=>reader.getSnapshot().panels[0].phase==='ready');
      expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(3); expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
    } finally { hold.resolve(); reader.dispose(); }
  });
  it('keeps established feed invalidations while hidden without new UI reads or renewal', async () => {
    const clock=manualClock();
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page) && h.waiting.has('instance:alpha'));
      reader.setPanelVisible(reader.getSnapshot().panels[0].key,false);
      expect(h.waiting.has('instance:alpha')).toBe(true);
      h.emit('instance:alpha',[{kind:'conversations.changed',scope:{instance_id:'instance:alpha'},revision:1}]);
      await until(()=>reader.getSnapshot().panels[0].catalog.page===null); expect(reader.getSnapshot().panels[0].error).toBeNull(); clock.advance(60000);
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1); expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(1);
    } finally { reader.dispose(); }
  });
  for(const invalidation of ['hidden','revoked','credential'] as const) it(`ignores a shared renewal retired while recovery waits: ${invalidation}`, async () => {
    const clock=manualClock(), hold=gate<void>(); let signal: AbortSignal | undefined;
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[10,20]}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page) && h.waiting.has('instance:alpha'));
      h.negotiate(async (id,dispatch,s)=> { signal=s; const response=h.negotiated(id,dispatch); await hold.promise; return response; });
      clock.advance(15000); await until(()=>Boolean(signal)); h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true)); await new Promise(r=>setTimeout(r,40));
      if(invalidation==='hidden') { reader.setPanelVisible(reader.getSnapshot().panels[0].key,false); clock.advance(31000); }
      else if(invalidation==='credential') h.changeCredential();
      else {
        h.directoryRead(async request=> { const page=h.directory(request); if(request.item_type==='instance_access') page.items=page.items.map(item=>'ref' in item && item.ref.instance_id==='instance:alpha' ? h.access('instance:alpha',true) : item); return page; });
        await h.owner()!.refreshDirectory();
      }
      expect(signal!.aborted).toBe(true); hold.resolve(); await new Promise(r=>setTimeout(r,15));
      if(invalidation==='credential') expect(reader.getSnapshot().phase).toBe('ended');
      else { expect(reader.getSnapshot().panels[0].catalog.page).toBeNull(); expect(reader.getSnapshot().panels[0].phase).not.toBe('ready'); }
      expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(2);
      expect(h.waiting.size).toBe(0); expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
    } finally { hold.resolve(); reader.dispose(); }
  });
  it('aborts initial preparation while hidden, ignores its late success and starts a fresh visible context', async () => {
    const clock=manualClock(), old=gate<void>(), next=gate<void>(); const signals: AbortSignal[]=[];
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer}), reader=new ConsumerReader(h.ports);
    h.negotiate(async (id,dispatch,signal)=> { const response=h.negotiated(id,dispatch); signals.push(signal); await (signals.length===1?old:next).promise; return response; });
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); await until(()=>signals.length===1);
      const key=reader.getSnapshot().panels[0].key; reader.setPanelVisible(key,false); expect(signals[0].aborted).toBe(true);
      old.resolve(); await new Promise(r=>setTimeout(r,15)); expect(h.calls.map(c=>c.dispatch.kind)).toEqual(['negotiate']); expect(h.waiting.size).toBe(0);
      reader.setPanelVisible(key,true); await until(()=>signals.length===2); expect(reader.getSnapshot().panels[0].catalog.page).toBeNull();
      next.resolve(); await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page) && h.waiting.has('instance:alpha'));
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
    } finally { old.resolve(); next.resolve(); reader.dispose(); }
    expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
  it('keeps shared initial preparation and a desired read for the remaining visible subscriber', async () => {
    const hold=gate<void>(); let signal: AbortSignal | undefined;
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000}), owner=h.ports.createOwner();
    h.negotiate(async (id,dispatch,s)=> { signal=s; const response=h.negotiated(id,dispatch); await hold.promise; return response; });
    try {
      await owner.refreshDirectory(); const first=owner.acquire('instance:alpha'), second=owner.acquire('instance:alpha');
      const body={instance_id:'instance:alpha',kind:'conversation' as const};
      const retired=first.read('conversations.catalog',body).catch(error=>error), kept=second.read('conversations.catalog',body);
      await until(()=>Boolean(signal)); first.setVisible(false); expect(signal!.aborted).toBe(false);
      expect(await retired).toMatchObject({code:'context_changed'}); await expect(first.read('conversations.catalog',body)).rejects.toMatchObject({code:'context_changed'});
      hold.resolve(); expect((await kept).response.type).toBe('response');
      expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(1); expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
      first.release(); second.release();
    } finally { hold.resolve(); owner.dispose(); }
  });
});


describe('visible lease admission uses one shared transition', () => {
  for(const stage of ['established','initial'] as const) for(const admission of ['acquire','two-acquires','setVisible'] as const) it(`resumes ${stage} through ${admission} with shared preparation and continuity`, async () => {
    const clock=manualClock(), hold=gate<void>(); let signal: AbortSignal | undefined;
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[5,10]}}), owner=h.ports.createOwner();
    if(stage==='initial') h.negotiate(async (id,dispatch,s)=> { const value=h.negotiated(id,dispatch); if(id==='instance:alpha') { signal=s; await hold.promise; } return value; });
    try {
      await owner.refreshDirectory(); const beta=owner.acquire('instance:beta'), first=owner.acquire('instance:alpha');
      await until(()=>beta.state().phase==='ready' && (stage==='initial'?Boolean(signal):first.state().phase==='ready' && h.waiting.has('instance:alpha')));
      const betaScope=beta.state().scope, version=first.state().catalogVersion;
      if(stage==='established') await first.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation'});
      first.setVisible(false); if(stage==='initial') { expect(signal!.aborted).toBe(true); hold.resolve(); await new Promise(r=>setTimeout(r,5)); }
      const leases=[first]; let visible=first;
      if(admission==='setVisible') first.setVisible(true);
      else { visible=owner.acquire('instance:alpha'); leases.push(visible); if(admission==='two-acquires') leases.push(owner.acquire('instance:alpha')); }
      await until(()=>h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate').length===2 && h.waiting.has('instance:alpha'));
      if(stage==='established') {
        expect(visible.state().phase).toBe('offline'); expect(visible.state().catalogVersion).toBe(version);
        h.emit('instance:alpha',[]);
      }
      await until(()=>visible.state().phase==='ready' && visible.state().authority!.valid);
      expect(clock.count()).toBe(2); clock.advance(15000);
      await until(()=>h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate').length===3 && visible.state().authority!.deadline>30000);
      expect(visible.state().authority!.valid).toBe(true); expect(beta.state().phase).toBe('ready'); expect(beta.state().scope).toEqual(betaScope);
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(stage==='established'?1:0);
      for(const lease of leases) lease.release(); beta.release();
    } finally { hold.resolve(); owner.dispose(); }
    expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
  for(const admission of ['acquire','two-acquires','setVisible'] as const) it(`keeps a known refusal closed through ${admission}`, async () => {
    const clock=manualClock(), h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[5,10]}}), owner=h.ports.createOwner();
    try {
      await owner.refreshDirectory(); const first=owner.acquire('instance:alpha'); await until(()=>first.state().phase==='ready' && h.waiting.has('instance:alpha'));
      h.failEvents('instance:alpha',new PilotClientError('forbidden',403)); await until(()=>first.state().phase==='error'); first.setVisible(false);
      const leases=[first]; let visible=first;
      if(admission==='setVisible') first.setVisible(true);
      else { visible=owner.acquire('instance:alpha'); leases.push(visible); if(admission==='two-acquires') leases.push(owner.acquire('instance:alpha')); }
      clock.advance(31000); await new Promise(r=>setTimeout(r,30));
      expect(visible.state().authority).toBeUndefined(); expect(visible.state().error).toBe('forbidden');
      await expect(visible.read('conversations.catalog',{instance_id:'instance:alpha',kind:'conversation'})).rejects.toMatchObject({code:'unavailable'});
      expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(1); expect(h.waiting.size).toBe(0); expect(clock.count()).toBe(0);
      for(const lease of leases) lease.release();
    } finally { owner.dispose(); }
  });
  it('keeps preparation useful to the first reader when a second immediate acquire is hidden', async () => {
    const hold=gate<void>(); let signal: AbortSignal | undefined;
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000}), owner=h.ports.createOwner();
    h.negotiate(async (id,dispatch,s)=> { signal=s; const value=h.negotiated(id,dispatch); await hold.promise; return value; });
    try {
      await owner.refreshDirectory(); const first=owner.acquire('instance:alpha'), second=owner.acquire('instance:alpha');
      await until(()=>Boolean(signal)); second.setVisible(false); expect(signal!.aborted).toBe(false);
      hold.resolve(); await until(()=>first.state().phase==='ready'); expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(1);
      second.release(); first.release();
    } finally { hold.resolve(); owner.dispose(); }
  });
});


describe('per-target presentation confirmation', () => {
  it('keeps an expired projection closed after continuity recovery exhausts despite a fresh proof', async () => {
    const clock=manualClock();
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[5,10]}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); reader.open('instance:beta');
      await until(()=>reader.getSnapshot().panels.every(p=>p.catalog.page) && h.waiting.size===2);
      reader.setTransportOnline(false); clock.advance(30001); reader.setTransportOnline(true);
      await until(()=>h.waiting.size===2); h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true));
      await until(()=>h.waiting.has('instance:alpha') && h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate').length===3);
      h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true)); await new Promise(r=>setTimeout(r,30));
      h.emit('instance:beta',[]); await until(()=>reader.getSnapshot().panels[1].phase==='ready');
      expect(reader.getSnapshot().panels[0].catalog.page).toBeNull(); expect(reader.getSnapshot().panels[1].catalog.page).not.toBeNull();
      expect(h.waiting.has('instance:alpha')).toBe(false); expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(2);
      expect(h.calls.filter(c=>c.id==='instance:alpha' && c.dispatch.kind==='negotiate')).toHaveLength(3);
    } finally { reader.dispose(); }
    expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
  });

  for(const elapsed of [1000,30001]) for(const firstIndex of [0,1]) it(`requires each target's own continuity after ${elapsed}ms, first notification ${firstIndex}`, async () => {
    const clock=manualClock();
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[5,10]}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha'); reader.open('instance:beta');
      await until(()=>reader.getSnapshot().panels.every(p=>p.catalog.page));
      for(const p of reader.getSnapshot().panels) reader.select(p.key,(p.catalog.page!.response.result.items[0] as ContentConversationCard).ref);
      await until(()=>reader.getSnapshot().panels.every(p=>p.detail.page) && h.waiting.size===2);
      const original=reader.getSnapshot().panels.map(p=>({catalog:p.catalog.page,detail:p.detail.page})), other=1-firstIndex;
      reader.setTransportOnline(false); clock.advance(elapsed);
      expect(reader.getSnapshot().panels.every(p=>Boolean(p.catalog.page)=== (elapsed<30000))).toBe(true);
      reader.setTransportOnline(true); await until(()=>h.waiting.size===2 && ['instance:alpha','instance:beta'].every(id=>h.calls.filter(c=>c.id===id && c.dispatch.kind==='negotiate').length===2));
      const panels=reader.getSnapshot().panels;
      h.emit(panels[firstIndex].instanceId,[]); await until(()=>reader.getSnapshot().panels[firstIndex].phase==='ready');
      expect(reader.getSnapshot().panels[firstIndex].detail.page).toBe(original[firstIndex].detail);
      expect(reader.getSnapshot().panels[other].catalog.page).toBe(elapsed<30000?original[other].catalog:null);
      expect(reader.getSnapshot().panels[other].detail.page).toBe(elapsed<30000?original[other].detail:null);
      expect(reader.getSnapshot().panels[other].passive).toBe(true); expect(h.waiting.has(panels[other].instanceId)).toBe(true);
      if(elapsed<30000) {
        // The new proof lasts until 31000, but pending continuity still uses the old 30000 bound.
        clock.advance(30000-elapsed);
        expect(reader.getSnapshot().panels[other].catalog.page).toBeNull(); expect(reader.getSnapshot().panels[other].detail.page).toBeNull();
      }
      h.emit(panels[other].instanceId,[]);
      const negotiations=elapsed<30000?5:4;
      await until(()=>reader.getSnapshot().panels.every(p=>p.phase==='ready') && h.calls.filter(c=>c.dispatch.kind==='negotiate').length===negotiations);
      for(const [index,p] of reader.getSnapshot().panels.entries()) {
        expect(p.catalog.page).toBe(original[index].catalog); expect(p.detail.page).toBe(original[index].detail);
        expect(p.catalog.page!.captureDeadline).toBe(original[index].catalog!.captureDeadline);
        expect(p.detail.page!.captureDeadline).toBe(original[index].detail!.captureDeadline);
      }
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(4);
      expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(negotiations);
    } finally { reader.dispose(); }
    expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
});


describe('ordinary renewal after the recovery budget', () => {
  for(const mode of ['exhausted-expired','exhausted-still-valid','healthy-expired','hidden','revoked','credential','refusal'] as const) it(`confirms presentation only with a continuous healthy feed: ${mode}`, async () => {
    const clock=manualClock(), hold=gate<void>(); let signal: AbortSignal | undefined, returned=false;
    const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[5,10],deadlineMs:60,maxDelayMs:20,pollIntervalMs:5}}), reader=new ConsumerReader(h.ports);
    try {
      reader.start(); await until(()=>reader.getSnapshot().phase==='ready'); reader.open('instance:alpha');
      await until(()=>Boolean(reader.getSnapshot().panels[0].catalog.page) && h.waiting.has('instance:alpha'));
      const original=reader.getSnapshot().panels[0].catalog.page;
      h.negotiate(async (id,dispatch,s)=> { signal=s; const response=h.negotiated(id,dispatch); await hold.promise; returned=true; if(mode==='refusal') throw new PilotClientError('forbidden',403); return response; });
      clock.advance(15000); await until(()=>Boolean(signal));
      if(mode!=='healthy-expired') {
        h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true));
        await until(()=>reader.getSnapshot().panels[0].phase==='offline'); await new Promise(r=>setTimeout(r,110));
      }
      if(mode!=='exhausted-still-valid') clock.advance(15001);
      if(mode==='hidden') reader.setPanelVisible(reader.getSnapshot().panels[0].key,false);
      else if(mode==='credential') h.changeCredential();
      else if(mode==='revoked') {
        h.directoryRead(async request=> { const page=h.directory(request); if(request.item_type==='instance_access') page.items=page.items.map(item=>'ref' in item && item.ref.instance_id==='instance:alpha'?h.access('instance:alpha',true):item); return page; });
        await h.owner()!.refreshDirectory();
      }
      expect(reader.getSnapshot().panels[0]?.catalog.page ?? null).toBe(mode==='exhausted-still-valid'?original:null);
      hold.resolve(); await until(()=>returned); await new Promise(r=>setTimeout(r,15));
      if(mode==='exhausted-still-valid') {
        expect(reader.getSnapshot().panels[0].catalog.page).toBe(original); clock.advance(15000);
      }
      if(mode==='healthy-expired') {
        await until(()=>reader.getSnapshot().panels[0].phase==='ready' && Boolean(reader.getSnapshot().panels[0].catalog.page));
        expect(reader.getSnapshot().panels[0].catalog.page).toBe(original);
        expect(reader.getSnapshot().panels[0].catalog.page!.captureDeadline).toBe(original!.captureDeadline); expect(signal!.aborted).toBe(false);
      } else {
        expect(reader.getSnapshot().panels[0]?.catalog.page ?? null).toBeNull();
        if(mode.startsWith('exhausted')) expect(reader.getSnapshot().panels[0].phase).toBe('authority_expired');
        else expect(signal!.aborted).toBe(true);
      }
      clock.advance(5000); await new Promise(r=>setTimeout(r,15));
      expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(2);
      expect(h.calls.filter(c=>c.dispatch.kind==='events')).toHaveLength(2);
      expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1);
      expect(h.waiting.size).toBe(mode==='healthy-expired'?1:0);
      if(mode!=='healthy-expired') expect(reader.getSnapshot().panels[0]?.catalog.page ?? null).toBeNull();
    } finally { hold.resolve(); reader.dispose(); }
    expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
  });
});


for(const elapsed of [1000,1001]) it(`notifies the subscribed projection when an unconfirmed proof contracts to M16000, observed at ${15000+elapsed}`, async () => {
  const clock=manualClock(), hold=gate<void>(); let signal: AbortSignal | undefined;
  const h=createConnectConsumerFixture({authorityLifetimeMs:30000,monotonicNow:clock.now,timer:clock.timer,retry:{...connectReaderRetry,delaysMs:[5,10],deadlineMs:60,maxDelayMs:20,pollIntervalMs:5}}), reader=new ConsumerReader(h.ports);
  let projection=reader.getSnapshot();
  // Like useSyncExternalStore, read only when notified; never pull at the authority deadline.
  const unsubscribe=reader.subscribe(()=> { projection=reader.getSnapshot(); });
  try {
    reader.start(); await until(()=>projection.phase==='ready'); reader.open('instance:alpha');
    await until(()=>Boolean(projection.panels[0]?.catalog.page) && h.waiting.has('instance:alpha'));
    const original=projection.panels[0].catalog.page;
    h.negotiate(async (id,dispatch,s)=> {
      signal=s; const response=h.negotiated(id,dispatch);
      response.read_authority!.expires_at=new Date(Date.parse(response.read_authority!.issued_at)+1000).toISOString();
      await hold.promise; return response;
    });
    clock.advance(15000); await until(()=>Boolean(signal));
    h.failEvents('instance:alpha',new PilotClientError('unavailable',503,true));
    await until(()=>projection.panels[0].phase==='offline'); await new Promise(r=>setTimeout(r,110));
    hold.resolve(); await new Promise(r=>setTimeout(r,15)); expect(projection.panels[0].catalog.page).toBe(original);
    clock.advance(elapsed); await new Promise(r=>setTimeout(r,2));
    expect(projection.panels[0].catalog.page).toBeNull(); expect(projection.panels[0].phase).toBe('authority_expired');
    expect(projection.panels[0].label).toBe(''); expect(projection.panels[0].passive).toBe(true);
    expect(h.calls.filter(c=>c.dispatch.kind==='submit')).toHaveLength(1); expect(h.calls.filter(c=>c.dispatch.kind==='negotiate')).toHaveLength(2);
    expect(h.calls.filter(c=>c.dispatch.kind==='events')).toHaveLength(2); expect(h.waiting.size).toBe(0);
  } finally { unsubscribe(); hold.resolve(); reader.dispose(); }
  expect(clock.count()).toBe(0); expect(h.waiting.size).toBe(0); expect(h.listeners.size).toBe(0);
});
