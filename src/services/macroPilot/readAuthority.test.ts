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
