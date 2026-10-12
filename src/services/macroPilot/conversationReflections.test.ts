import { describe, expect, it } from 'bun:test';
import { ConversationReflections, REFLECTION_LIMITS, type ReflectionObservation } from './conversationReflections';
import type { ContentDelivery, ContentReflections } from './contentProtocol';
import { validateContentMessage, validateContentResponse, validatePageContinuation } from './contentProtocol';
const epoch = Date.parse('2026-01-01T00:00:00Z');
const ref = { instance_id: 'instance-demo',kind: 'conversation' as const,conversation_id: 'conversation-demo' };
const request = (continuation?: { snapshot_id: string;cursor: string }): ContentDelivery => ({ transport_version: '2.0',type: 'delivery',request_id: 'request-demo',account_id: 'account-demo',instance_id: 'instance-demo',source_session_id: 'session-demo',authority_binding: 'grant-demo',capabilities: ['conversations-1','conversation-reflections-1'],expires_at: new Date(epoch+600000).toISOString(),request: { contract_version: '2.0',type: 'request',request_id: 'request-demo',account_id: 'account-demo',operation: 'conversation.reflections.read',body: { ref,message_id: 'assistant-demo',...(continuation ? { continuation } : {}) } } });
const response = (result: ContentReflections) => ({ contract_version: '2.0',type: 'response',request_id: 'request-demo',account_id: 'account-demo',operation: 'conversation.reflections.read',result });
function setup(active = false) {
  let time=epoch; let reads=0; let checks=0;
  const state: ReflectionObservation = { content: '<think>réflexion</think>final',metadata: '[]',blocks: [{ content: 'réflexion',partial: false }],turnId: 'turn-demo',source: active ? 'active' : 'history',generationId: active ? 'generation-demo' : null };
  const host = new ConversationReflections({ available: () => true,validateTarget: async target => { checks++; if (JSON.stringify(target) !== JSON.stringify(ref)) throw new Error('not_found'); },observe: async () => { reads++; return structuredClone(state); } },() => time);
  host.enable(true);
  return { host,state,policy: { revision: 'visible-1',secrets: [] as string[] },authorize: async () => new Date(time+5000).toISOString(),time: (value: number) => { time=value; },reads: () => reads,checks: () => checks };
}
describe('visible reflection captures',() => {
  it('binds real message and turn while keeping tool traces outside the response',async () => {
    const s=setup(); const delivery=request();
    const result=await s.host.handle(delivery,s.policy,s.authorize);
    expect(validateContentResponse(delivery.request,response(result))).toBe(true);
    expect(result.message_id).toBe('assistant-demo'); expect(result.turn_id).toBe('turn-demo');
    expect(result.items.map(item => item.text)).toEqual(['réflexion']);
    expect(s.reads()).toBe(2); expect(s.checks()).toBeGreaterThanOrEqual(2);
  });
  it('paginates complete UTF-8 characters with frozen offsets and ordered blocks',async () => {
    const s=setup(); const text='🧪é'.repeat(15000);
    s.state.content=`<think>${text}</think>`;s.state.blocks=[{ content: text,partial: false },{ content: 'suivante',partial: true }];
    let result=await s.host.handle(request(),s.policy,s.authorize);let assembled='';let pages=0;
    while (true) {
      assembled+=result.items.map(item => item.text).join('');pages++;
      for (const item of result.items) expect(new TextEncoder().encode(item.text).length).toBeLessThanOrEqual(8192);
      expect(validateContentMessage(response(result))).toBe(true);
      if (!result.page.next_cursor) break;
      const delivery=request({ snapshot_id: result.page.snapshot_id,cursor: result.page.next_cursor });
      const next=await s.host.handle(delivery,s.policy,s.authorize);
      expect(validatePageContinuation(response(result),response(next),{ request: delivery.request }).valid).toBe(true);
      result=next;
    }
    expect(pages).toBe(2);expect(assembled).toBe(text+'suivante');
  });
  it('checks a secret after the first page and across blocks before emitting any fragment',async () => {
    for (const blocks of [[{ content: 'x'.repeat(70000)+'secret-value',partial: false }],[{ content: 'secret-',partial: false },{ content: 'value',partial: false }]]) {
      const s=setup();s.policy.secrets=['secret-value'];s.state.content='x'.repeat(70050);s.state.blocks=blocks;
      const result=await s.host.handle(request(),s.policy,s.authorize);
      expect(result.content_state).toBe('withheld');expect(result.items).toEqual([]);
    }
  });
  it('keeps an active captured prefix during append, then rejects rewrite, owner change and completion',async () => {
    const s=setup(true);s.state.content='<think>'+ 'a'.repeat(70000);s.state.blocks=[{ content: 'a'.repeat(70000),partial: true }];
    const first=await s.host.handle(request(),s.policy,s.authorize);
    expect(first.source).toBe('active');expect(first.items[0].state).toBe('partial');
    const continued=request({ snapshot_id: first.page.snapshot_id,cursor: first.page.next_cursor! });
    s.state.content+=' addition</think>final';s.state.blocks=[{ content: 'a'.repeat(70000)+' addition',partial: false }];
    const second=await s.host.handle(continued,s.policy,s.authorize);
    expect(second.items.map(item => item.text).join('')).toBe('a'.repeat(70000-65536));
    expect(second.items[0].state).toBe('partial');
    s.state.content=s.state.content.replace('aaa','bbb');
    await expect(s.host.validateEmission(request(),first,s.policy,s.authorize)).rejects.toThrow('stale_revision');
    for (const change of ['owner','completed']) {
      const s2=setup(true);const current=await s2.host.handle(request(),s2.policy,s2.authorize);
      if (change==='owner') s2.state.generationId='new-generation';else { s2.state.source='history';s2.state.generationId=null; }
      await expect(s2.host.validateEmission(request(),current,s2.policy,s2.authorize)).rejects.toThrow('stale_revision');
    }
  });
  it('expires absolutely and denies a cursor under another session, binding, target or policy',async () => {
    const s=setup(true);const result=await s.host.handle(request(),s.policy,s.authorize);
    for (const field of ['source_session_id','authority_binding']) {
      const wrong=request();(wrong as unknown as Record<string,unknown>)[field]='foreign-demo';
      await expect(s.host.validateEmission(wrong,result,s.policy,s.authorize)).rejects.toThrow('snapshot_expired');
    }
    await expect(s.host.validateEmission(request(),result,{ revision: 'visible-2',secrets: [] },s.authorize)).rejects.toThrow('snapshot_expired');
    s.time(epoch+15000);await expect(s.host.validateEmission(request(),result,s.policy,s.authorize)).rejects.toThrow('snapshot_expired');
  });
  it('fails authorization before hydration and holds a fixed final deadline through source reads',async () => {
    const s=setup();await expect(s.host.handle(request(),s.policy,async () => { throw new Error('forbidden'); })).rejects.toThrow('forbidden');expect(s.reads()).toBe(0);
    let time=epoch;let reads=0;let auth=0;
    const h=new ConversationReflections({ available: () => true,validateTarget: async () => {},observe: async () => { reads++; if (reads===2) time+=6000;return s.state; } },() => time);h.enable(true);
    await expect(h.handle(request(),s.policy,async () => { auth++;return new Date(time+5000).toISOString(); })).rejects.toThrow('snapshot_expired');expect(auth).toBe(2);
  });
  it('distinguishes pending, absent and oversized sources and releases cache on disable',async () => {
    const s=setup();s.state.blocks=[];const absent=await s.host.handle(request(),s.policy,s.authorize);expect(absent.content_state).toBe('absent');
    s.state.source='active';s.state.generationId='generation-demo';const pending=await s.host.handle(request(),s.policy,s.authorize);expect(pending.content_state).toBe('pending');
    s.state.content='a'.repeat(REFLECTION_LIMITS.sourceBytes+1);const large=await s.host.handle(request(),s.policy,s.authorize);expect(large.content_state).toBe('too_large');
    s.host.enable(false);await expect(s.host.handle(request(),s.policy,s.authorize)).rejects.toThrow('validation_failed');s.host.enable(true);
    await expect(s.host.validateEmission(request(),pending,s.policy,s.authorize)).rejects.toThrow('snapshot_expired');
  });
  it('bounds retained captures before hydrating an additional source',async () => {
    const s=setup();for (let i=0;i<16;i++) await s.host.handle(request(),s.policy,s.authorize);
    const reads=s.reads();await expect(s.host.handle(request(),s.policy,s.authorize)).rejects.toThrow('resource_limit');expect(s.reads()).toBe(reads);
  });
});

it('keeps JSON-escaped control text under the envelope bound without losing pagination',async () => {
  const s=setup();s.state.content='<think>'+'\u0001'.repeat(70000)+'</think>';s.state.blocks=[{content:'\u0001'.repeat(70000),partial:false}];
  let result=await s.host.handle(request(),s.policy,s.authorize);let bytes=0;let pages=0;
  while (true) {
    expect(validateContentMessage(response(result))).toBe(true);bytes+=result.items.reduce((n,item)=>n+item.text.length,0);pages++;
    if (!result.page.next_cursor) break;
    const next=await s.host.handle(request({snapshot_id:result.page.snapshot_id,cursor:result.page.next_cursor}),s.policy,s.authorize);
    expect(validatePageContinuation(response(result),response(next)).valid).toBe(true);result=next;
  }
  expect(bytes).toBe(70000);expect(pages).toBeGreaterThan(2);
});
