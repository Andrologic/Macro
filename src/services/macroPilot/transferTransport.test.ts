import { describe, expect, it, spyOn } from 'bun:test';
import vectors from '../../../contracts/macro-pilot/v2/transfer-transit/vectors.json';
import type { TransitDelivery, TransitDecisionRequest, TransitReceived, TransitAttestation, TransitChallenge } from '../../../contracts/macro-pilot/v2/transfer-transit/validate.mjs';
import type { DecisionExchange, DecisionExpectation, DecisionProducer } from '../../../contracts/macro-pilot/v2/transfer-decision.js';
import { MacroPilotNativeClient, type PilotClientDependencies } from './nativeClient';
import { loadTransferCodec, readProducerPollReply, TRANSFER_HEADER, TRANSFER_VERSION, TRANSFER_ADMISSION, TRANSFER_BODY_BYTES, type TransferReception } from './transferTransport';
import { validateContentMessage } from './contentProtocol';
const c = vectors.context;
const account = { contract_version: '1.0', type: 'account', account_id: 'account:synthetic', identity: { provider: 'github', subject: 'synthetic', login: 'synthetic' }, revision: 1 };
const session = { contract_version: '1.0', type: 'device_session', ref: { type: 'device_session', account_id: account.account_id, session_id: 'session:synthetic' }, device_id: 'device:synthetic', state: 'active', issued_at: '2026-10-23T00:00:00Z', revision: 1 };
const producer = c.producer as DecisionProducer, exchange = c.proof.exchange as DecisionExchange;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const response = (value: unknown, id: string, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'X-Request-Id': id } });
function harness() {
  const values: Record<string, unknown> = { macro_pilot_native_v1: { configurationId: 'config:synthetic', relayOrigin: 'https://relay.example.test', account, deviceSession: session,
    instance: { contract_version: '1.0', type: 'instance', ref: { type: 'instance', instance_id: producer.instance_id }, label: 'Synthetic', connection_state: 'reachable', supported_contract_versions: ['1.0'], revision: 1 }, instanceCreationId: 'creation:synthetic' } };
  const requests: Array<{url:string;init:RequestInit}> = [];let next: Response | undefined;let live = 0, dispatches = 0, guards = 0;
  const deps: PilotClientDependencies = {
    fetch: async (url, init) => { requests.push({url:String(url),init:init ?? {}});if (!next) return response({ account, device_session: session }, 'bootstrap');const result=next.clone();if(next.url)Object.defineProperty(result,'url',{value:next.url});return result; },
    getStateSnapshot: async () => ({ schemaVersion: 1, values }), setStateValue: async (key, value) => { values[key] = value; return {schemaVersion:1,values}; },
    secretRead: async () => 'c3ludGhldGljLXNlY3JldA', secretWrite: async () => {}, secretDelete: async () => {}, randomBytes: size => new Uint8Array(size).fill(1), sha256: async () => new Uint8Array(32), now: () => new Date('2026-10-23T10:00:00Z'),
  };
  const client = new MacroPilotNativeClient(deps);
  return {client,deps,requests,set next(x:Response){next=x;},get live(){return live;},get guards(){return guards;},get dispatches(){return dispatches;},options:{reserve:(n:number)=>{expect(n).toBe(TRANSFER_ADMISSION);live++;return()=>{live--;};},beforeSend:async()=>{guards++;},onDispatch:()=>{dispatches++;}}};
}
const proofReceived = () => {
  const sent = structuredClone(vectors.valid.find(x => x.type === 'proof.received')) as TransitReceived;sent.request_id = exchange.delivery_id;
  return {sent, reception:{kind:'received',sent,exchange} as TransferReception,path:`/pilot/v2/transfers/instances/${producer.instance_id}/received`};
};
const signal=()=>new AbortController().signal;
describe('inactive transfer metadata NativeClient', () => {
  it('uses exact received/attestation IDs, existing credentials and distinct routes without coalescing', async () => {
    const h=harness();await h.client.initialize();const x=proofReceived();h.next=response({transit_contract:TRANSFER_VERSION,type:'accepted',request_id:x.sent.request_id},x.sent.request_id);
    await h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),h.options, () => {});
    const a=structuredClone(vectors.valid.find(x=>x.type==='proof.result')) as TransitAttestation;a.request_id=exchange.delivery_id;
    await h.client.requestTransferMetadata(`/pilot/v2/transfers/instances/${producer.instance_id}/attestations`,a,{kind:'attestation',sent:a,exchange,producer,connection:producer.connection_id},signal(),h.options, () => {});
    const sent=h.requests.filter(x=>x.url.includes('/transfers/'));expect(sent).toHaveLength(2);expect(sent[0].url).not.toBe(sent[1].url);
    for(const request of sent){const headers=new Headers(request.init.headers);expect(headers.get('X-Request-Id')).toBe(exchange.delivery_id);expect(headers.get('Authorization')).toBe('Bearer c3ludGhldGljLXNlY3JldA');expect(headers.get('X-Instance-Key')).toBe('c3ludGhldGljLXNlY3JldA');expect(headers.has(TRANSFER_HEADER)).toBe(false);expect(JSON.parse(String(request.init.body)).request_id).toBe(exchange.delivery_id);}
    expect(h.guards).toBe(2);expect(h.dispatches).toBe(2);expect(h.live).toBe(0);
  });
  it('correlates the canonical decision reply and challenge against independent expected facts', async () => {
    const h=harness();await h.client.initialize();const sent=structuredClone(c.decisionRequest) as TransitDecisionRequest;h.next=response(c.reply,sent.request_id);
    const b=sent.request.operation==='reserve'?sent.request.body.binding:null;if(!b)throw Error();const path=`/pilot/v2/transfers/sources/${b.provenance.source.source_instance_id}/${b.provenance.source.source_conversation_id}/targets/${b.target_instance_id}/reservations/${b.transfer_id}/decisions`;
    await h.client.requestTransferMetadata(path,sent,{kind:'decision',sent,expectation:c.expectation as DecisionExpectation},signal(),h.options, () => {});
    const challenge=structuredClone(c.challenge) as TransitChallenge;h.next=response(c.exchange,challenge.request_id);
    const { delivery_id: _delivery, challenge_id: _challenge, ...expectedExchange } = exchange;
    await h.client.requestTransferMetadata(`/pilot/v2/transfers/known/${b.transfer_id}/challenges`,challenge,{kind:'challenge',sent:challenge,exchange:expectedExchange},signal(),h.options, () => {});
    expect(h.live).toBe(0);
    const wrong=structuredClone(c.reply);wrong.result.receipt.subject_digest='f'.repeat(64);h.next=response(wrong,sent.request_id);
    await expect(h.client.requestTransferMetadata(path,sent,{kind:'decision',sent,expectation:c.expectation as DecisionExpectation},signal(),h.options, () => {})).rejects.toThrow('invalid_response');
    expect(h.live).toBe(0);
  });
  it.each(['id','route','payload','quota','guard'] as const)('refuses %s before dispatch and returns admission', async kind => {
    const h=harness();await h.client.initialize();const x=proofReceived();h.next=response({transit_contract:TRANSFER_VERSION,type:'accepted',request_id:x.sent.request_id},x.sent.request_id);
    if(kind==='id')x.sent.request_id='different';if(kind==='route')x.path=x.path.replace(producer.instance_id,'other');
    const options={...h.options};if(kind==='quota')options.reserve=()=>{throw Error('resource_limit');};if(kind==='guard')options.beforeSend=async()=>{throw Error('guard refused');};
    if(kind==='payload')Object.assign(x.sent,c.first);
    await expect(h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),options, () => {})).rejects.toThrow();
    expect(h.dispatches).toBe(0);expect(h.live).toBe(0);
  });
  it.each(['duplicate','header','redirect','payload','error'] as const)('refuses or preserves the exact %s response without v1 fallback', async kind => {
    const h=harness();await h.client.initialize();const x=proofReceived();const accepted={transit_contract:TRANSFER_VERSION,type:'accepted',request_id:x.sent.request_id};
    if(kind==='duplicate')h.next=new Response(JSON.stringify(accepted).slice(0,-1)+',"request_\\u0069d":'+JSON.stringify(x.sent.request_id)+'}',{headers:{'X-Request-Id':x.sent.request_id}});
    if(kind==='header')h.next=response(accepted,'wrong');if(kind==='redirect'){const r=response(accepted,x.sent.request_id);Object.defineProperty(r,'url',{value:'https://other.example.test/'});h.next=r;}
    if(kind==='payload')h.next=response({...c.first,request_id:x.sent.request_id},x.sent.request_id);
    if(kind==='error')h.next=response({transit_contract:TRANSFER_VERSION,type:'error',request_id:x.sent.request_id,code:'producer_changed',retryable:false},x.sent.request_id,409);
    await expect(h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),h.options, () => {})).rejects.toThrow(kind==='error'?'producer_changed':kind==='redirect'?'redirect_refused':'invalid_response');
    expect(h.live).toBe(0);expect(h.requests.filter(x=>x.url.includes('/transfers/'))).toHaveLength(1);
  });
  it('cancels a response over 96KiB before consuming metadata', async () => {
    const h = harness();
    await h.client.initialize();
    const x = proofReceived();
    let cancelled = 0, consumed = false;
    h.deps.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(TRANSFER_BODY_BYTES + 1).fill(32)); },
      cancel() { cancelled++; },
    }), { headers: { 'X-Request-Id': x.sent.request_id } });
    await expect(h.client.requestTransferMetadata(x.path, x.sent, x.reception, signal(), h.options, () => { consumed = true; })).rejects.toThrow('invalid_response');
    expect(consumed).toBe(false);
    expect(cancelled).toBe(1);
    expect(h.live).toBe(0);
  });
  it.each(['decision', 'challenge', 'received', 'attestation'] as const)('refuses malformed %s facts before cloning or dispatch', async kind => {
    const h = harness();
    await h.client.initialize();
    for (const mutation of ['extension', 'oversize', 'prototype', 'getter', 'wrapper', 'unshared', 'sent-getter'] as const) {
      const received = proofReceived();
      const sent = kind === 'decision' ? structuredClone(c.decisionRequest) as TransitDecisionRequest
        : kind === 'challenge' ? structuredClone(c.challenge) as TransitChallenge
        : kind === 'attestation' ? structuredClone(vectors.valid.find(value => value.type === 'proof.result')) as TransitAttestation
        : received.sent;
      if (sent.type === 'proof.result') sent.request_id = exchange.delivery_id;
      const { delivery_id: _delivery, challenge_id: _challenge, ...expectedExchange } = exchange;
      const reception: TransferReception = kind === 'decision' ? { kind, sent: sent as TransitDecisionRequest, expectation: structuredClone(c.expectation) as DecisionExpectation }
        : kind === 'challenge' ? { kind, sent: sent as TransitChallenge, exchange: structuredClone(expectedExchange) }
        : kind === 'attestation' ? { kind, sent: sent as TransitAttestation, exchange: structuredClone(exchange), producer: structuredClone(producer), connection: producer.connection_id }
        : { kind, sent: sent as TransitReceived, exchange: structuredClone(exchange) };
      const authority = reception.kind === 'decision' ? reception.expectation! : reception.exchange;
      if (mutation === 'extension') Object.assign(authority, { unexpected: true });
      if (mutation === 'oversize') {
        if (reception.kind === 'decision') reception.expectation!.binding.provenance.source.account_id = 'x'.repeat(128 * 1024);
        else reception.exchange.instance_id = 'x'.repeat(128 * 1024);
      }
      if (mutation === 'prototype') Object.setPrototypeOf(authority, { inherited: true });
      if (mutation === 'getter') {
        const key = reception.kind === 'decision' ? 'binding' : 'binding_digest';
        const value = Object.getOwnPropertyDescriptor(authority, key)!.value;
        Object.defineProperty(authority, key, { enumerable: true, get: () => value });
      }
      if (mutation === 'wrapper') Object.assign(reception, { unexpected: 'x'.repeat(128 * 1024) });
      if (mutation === 'unshared') reception.sent = structuredClone(sent) as typeof reception.sent;
      if (mutation === 'sent-getter') Object.defineProperty(sent, 'request_id', { enumerable: true, get: () => exchange.delivery_id });
      const request = c.decisionRequest.request;
      if (request.operation !== 'reserve') throw Error('synthetic reserve required');
      const binding = request.body.binding;
      const path = kind === 'decision' ? `/pilot/v2/transfers/sources/${binding.provenance.source.source_instance_id}/${binding.provenance.source.source_conversation_id}/targets/${binding.target_instance_id}/reservations/${binding.transfer_id}/decisions`
        : kind === 'challenge' ? `/pilot/v2/transfers/known/${binding.transfer_id}/challenges`
        : `/pilot/v2/transfers/instances/${producer.instance_id}/${kind === 'attestation' ? 'attestations' : 'received'}`;
      const clone = spyOn(globalThis, 'structuredClone');
      try {
        await expect(h.client.requestTransferMetadata(path, sent, reception, signal(), h.options, () => {})).rejects.toThrow('invalid_response');
        expect(clone).not.toHaveBeenCalled();
      } finally { clone.mockRestore(); }
      expect(h.live).toBe(0);
      expect(h.dispatches).toBe(0);
    }
  });
  it.each(['producer', 'connection'] as const)('refuses a malformed attestation %s before cloning', async field => {
    const h = harness();
    await h.client.initialize();
    const sent = structuredClone(vectors.valid.find(value => value.type === 'proof.result')) as TransitAttestation;
    sent.request_id = exchange.delivery_id;
    const reception: TransferReception = { kind: 'attestation', sent, exchange: structuredClone(exchange), producer: structuredClone(producer), connection: producer.connection_id };
    if (field === 'producer') reception.producer.generation = 'x'.repeat(128 * 1024);
    else reception.connection = 'x'.repeat(128 * 1024);
    const clone = spyOn(globalThis, 'structuredClone');
    try {
      await expect(h.client.requestTransferMetadata(`/pilot/v2/transfers/instances/${producer.instance_id}/attestations`, sent, reception, signal(), h.options, () => {})).rejects.toThrow('invalid_response');
      expect(clone).not.toHaveBeenCalled();
    } finally { clone.mockRestore(); }
    expect(h.live).toBe(0);
    expect(h.dispatches).toBe(0);
  });
  it('refuses the two generic graphs under 32MiB before dispatch and releases the first charge',async()=>{
    const h=harness();await h.client.initialize();const x=proofReceived();let used=0,released=0;
    const options={...h.options,reserve:(units:number)=>{if(used+units>32*1024*1024)throw Error('resource_limit');used+=units;return()=>{used-=units;released++;};}};
    await expect(h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),options,()=>{throw Error('not called');})).rejects.toThrow('resource_limit');
    expect(used).toBe(0);expect(released).toBe(1);expect(h.dispatches).toBe(0);expect(h.requests.filter(x=>x.url.includes('/transfers/'))).toHaveLength(0);
  });
  it('holds the logical metadata reservations until the JavaScript fetch settles after abort', async () => {
    const h=harness();await h.client.initialize();const x=proofReceived();let entered!:()=>void,finish!:(r:Response)=>void;const enteredPromise=new Promise<void>(r=>{entered=r;});
    h.deps.fetch=()=>{entered();return new Promise<Response>(r=>{finish=r;});};const controller=new AbortController();let settled=false;
    const pending=h.client.requestTransferMetadata(x.path,x.sent,x.reception,controller.signal,h.options, () => {}).finally(()=>{settled=true;});await enteredPromise;controller.abort();await Promise.resolve();expect(h.live).toBe(2);expect(settled).toBe(false);
    finish(response({transit_contract:TRANSFER_VERSION,type:'accepted',request_id:x.sent.request_id},x.sent.request_id));await expect(pending).rejects.toThrow();expect(h.live).toBe(0);
  });
  it.each(['transfer', 'ordinary'] as const)('cancels a late %s body when context changes without aborting its signal', async kind => {
    const h = harness();
    await h.client.initialize();
    const x = proofReceived();
    let entered!: () => void;
    let finish!: (value: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.deps.fetch = async (url, init) => {
      if (String(url).endsWith('/me')) return response({ account, device_session: session }, 'bootstrap');
      requestSignal = init?.signal ?? undefined;
      entered();
      return await new Promise<Response>(resolve => { finish = resolve; });
    };
    const pending = kind === 'transfer'
      ? h.client.requestTransferMetadata(x.path, x.sent, x.reception, signal(), h.options, () => {})
      : h.client.request('POST', '/late-body', {}, { authenticated: true });
    await started;
    const snapshot = await h.deps.getStateSnapshot();
    h.deps.getStateSnapshot = async () => ({ ...snapshot, values: { ...snapshot.values,
      macro_pilot_native_v1: { ...(snapshot.values.macro_pilot_native_v1 as Record<string, unknown>), configurationId: 'config:replacement' },
    } });
    await h.client.initialize();
    expect(requestSignal?.aborted).toBe(false);
    let cancelled = 0;
    finish(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await expect(pending).rejects.toThrow('context_changed');
    expect(cancelled).toBe(1);
    expect(h.live).toBe(0);
  });
  it('returns only the logical charge after body abort, without waiting for simulated native completion', async () => {
    const h = harness();
    await h.client.initialize();
    const x = proofReceived();
    const controller = new AbortController();
    let reading!: () => void;
    let finishCancel!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    let cancelled = false, cancellationFinished = false, consumed = false;
    h.deps.fetch = async () => new Response(new ReadableStream({
      pull() { reading(); return new Promise<void>(() => {}); },
      cancel() {
        cancelled = true;
        return new Promise<void>(resolve => { finishCancel = () => { cancellationFinished = true; resolve(); }; });
      },
    }), { headers: { 'X-Request-Id': x.sent.request_id } });
    const pending = h.client.requestTransferMetadata(x.path, x.sent, x.reception, controller.signal, h.options, () => { consumed = true; });
    await started;
    expect(h.live).toBe(2);
    controller.abort();
    await expect(pending).rejects.toThrow('context_changed');
    expect(cancelled).toBe(true);
    expect(cancellationFinished).toBe(false);
    expect(consumed).toBe(false);
    expect(h.live).toBe(0);
    finishCancel();
  });
  it('holds admission until the awaited metadata consumer ends, including rejection', async () => {
    const h=harness();await h.client.initialize();const x=proofReceived();h.next=response({transit_contract:TRANSFER_VERSION,type:'accepted',request_id:x.sent.request_id},x.sent.request_id);
    let finish!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
    const pending=h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),h.options,async reply=>{expect(reply.data).toMatchObject({type:'accepted'});entered();await new Promise<void>(r=>{finish=r;});throw Error('consumer refused');});
    await started;expect(h.live).toBe(2);finish();await expect(pending).rejects.toThrow('consumer refused');expect(h.live).toBe(0);
  });
  it('rejects a changed session after a pending credential read without dispatch',async()=>{
    const h=harness();await h.client.initialize();const x=proofReceived();let entered!:()=>void,finish!:(s:string)=>void;const started=new Promise<void>(r=>{entered=r;});let reads=0;
    h.deps.secretRead=()=>{if(reads++===0){entered();return new Promise<string>(r=>{finish=r;});}return Promise.resolve('c3ludGhldGljLXNlY3JldA');};
    h.deps.fetch=async()=>new Response(null,{status:204});
    const pending=h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),h.options,()=>{});await started;await h.client.logout();finish('c3ludGhldGljLXNlY3JldA');
    await expect(pending).rejects.toThrow('context_changed');expect(h.dispatches).toBe(0);expect(h.live).toBe(0);
  });
  it('keeps the ordinary poll unoffered and rejects a confirmed F response before its body is read',async()=>{
    const h=harness();await h.client.initialize();const path=`/pilot/v2/instances/${producer.instance_id}/deliveries/poll`;const poll={transport_version:'2.0',type:'poll',commands:['conversation.send']};
    h.next=new Response(null,{status:204});expect((await h.client.requestContent(path,poll,signal())).status).toBe(204);
    expect(new Headers(h.requests.at(-1)!.init.headers).has(TRANSFER_HEADER)).toBe(false);
    let cancelled=0;h.deps.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{[TRANSFER_HEADER]:TRANSFER_VERSION}});
    await expect(h.client.requestContent(path,poll,signal())).rejects.toThrow('invalid_response');expect(cancelled).toBe(1);
  });
  it('keeps the original request snapshot across the emission guard', async () => {
    const h=harness();await h.client.initialize();const x=proofReceived();h.next=response({transit_contract:TRANSFER_VERSION,type:'accepted',request_id:x.sent.request_id},x.sent.request_id);
    h.options.beforeSend=async()=>{x.sent.request_id='mutated-after-prepare';};await h.client.requestTransferMetadata(x.path,x.sent,x.reception,signal(),h.options, () => {});
    expect(JSON.parse(String(h.requests.at(-1)!.init.body)).request_id).toBe(exchange.delivery_id);expect(h.live).toBe(0);
  });
});

describe('producer response union, no native owner',()=>{
  it('keeps silent v2 parsing and rejects unsolicited confirmation before reading',async()=>{
    let legacy=0,loaded=0;const base={offered:null,requestId:'poll',instanceId:producer.instance_id,producerGeneration:null,connectionId:null,reserve:()=>()=>{},load:async()=>{loaded++;return bytes({});},legacy:async()=>{legacy++;return {ordinary:true};},validateContent:validateContentMessage,consumeTransfer:()=>{}};
    expect((await readProducerPollReply(new Response(null,{status:204}),base)).branch).toBe('empty');expect(legacy).toBe(1);
    for(const header of [TRANSFER_VERSION,TRANSFER_VERSION+', '+TRANSFER_VERSION,'unknown']){await expect(readProducerPollReply(new Response(null,{headers:{[TRANSFER_HEADER]:header}}),base)).rejects.toThrow();}
    expect(loaded).toBe(0);expect(legacy).toBe(1);
  });
  it('decodes only confirmed metadata and refuses payload before callback consumption',async()=>{
    const d=structuredClone(vectors.valid.find(x=>x.type==='producer.delivery')) as TransitDelivery;let live=0;const options={offered:TRANSFER_VERSION,requestId:d.request_id,instanceId:d.instance_id,producerGeneration:d.producer_generation,connectionId:d.connection_id,reserve:()=>{live++;return()=>{live--;};},load:async()=>bytes(d),legacy:async()=>{throw Error('no fallback');},validateContent:validateContentMessage,consumeTransfer:()=>{}};
    let consumed=0;Object.assign(options,{consumeTransfer:()=>{consumed++;expect(live).toBe(1);}});
    const r=new Response(null,{headers:{[TRANSFER_HEADER]:TRANSFER_VERSION,'X-Request-Id':d.request_id}});expect((await readProducerPollReply(r,options)).branch).toBe('transfer');expect(live).toBe(0);expect(consumed).toBe(1);
    const payload=structuredClone(vectors.valid.find(x=>x.type==='producer.delivery'&&x.body?.kind==='transit.chunk')) as TransitDelivery;options.requestId=payload.request_id;options.load=async()=>bytes(payload);
    await expect(readProducerPollReply(new Response(null,{headers:{[TRANSFER_HEADER]:TRANSFER_VERSION,'X-Request-Id':payload.request_id}}),options)).rejects.toThrow();expect(live).toBe(0);
    const a=await loadTransferCodec(),b=await loadTransferCodec();expect(a).toBe(b);expect(a.LIMITS.admission).toBe(TRANSFER_ADMISSION);expect(a.LIMITS.body).toBe(98304);expect(a.diagnosticsEmpty()).toBe(true);
  });
});
