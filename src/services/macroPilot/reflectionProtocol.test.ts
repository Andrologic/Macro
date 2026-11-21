import { expect,it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { validateMessage,validateExchange,validatePageContinuation,type ContentRequest,type ContentResponse } from './contentProtocol';
const portable=await import(new URL('../../../contracts/macro-pilot/v2/validate.mjs',import.meta.url).href) as { validateMessage: typeof validateMessage;validateExchange: typeof validateExchange;validatePageContinuation: typeof validatePageContinuation };
const fixture=async <T>(kind:string):Promise<T>=>JSON.parse(await readFile(new URL(`../../../contracts/macro-pilot/v2/fixtures/valid/${kind}-conversation.reflections.read.json`,import.meta.url),'utf8'));
it('requires an attested binding and independent conversations capability for reflection deliveries',async()=>{
  const request=await fixture<ContentRequest<'conversation.reflections.read'>>('request');
  const delivery={ transport_version:'2.0',type:'delivery',request_id:request.request_id,account_id:request.account_id,instance_id:request.body.ref.instance_id,source_session_id:'session-demo',authority_binding:'grant-demo',capabilities:['conversations-1','conversation-reflections-1'],expires_at:'2026-01-01T00:06:00Z',request };
  for(const helper of [validateMessage,portable.validateMessage]){
    expect(helper(delivery).valid).toBe(true);
    expect(helper({...delivery,authority_binding:undefined}).valid).toBe(false);
    expect(helper({...delivery,capabilities:['conversation-reflections-1']}).valid).toBe(false);
    expect(helper({...delivery,capabilities:['conversations-1']}).valid).toBe(false);
  }
});
it('rejects wrong message, turn capture continuity, Unicode overrun and active lifetime inflation',async()=>{
  const request=await fixture<ContentRequest<'conversation.reflections.read'>>('request');const response=await fixture<ContentResponse<'conversation.reflections.read'>>('response');
  for(const helper of [validateExchange,portable.validateExchange]) expect(helper(request,{...response,result:{...response.result,message_id:'foreign-demo'}}).valid).toBe(false);
  for(const helper of [validateMessage,portable.validateMessage]){
    const unicode=structuredClone(response);unicode.result.items[0].text='🧪';unicode.result.items[0].total_bytes=3;expect(helper(unicode).valid).toBe(false);
    unicode.result.items[0].total_bytes=4;expect(helper(unicode).valid).toBe(true);
    unicode.result.source='active';unicode.result.generation_id='generation-demo';expect(helper(unicode).valid).toBe(false);
    unicode.result.page.expires_at='2026-01-01T00:00:15Z';expect(helper(unicode).valid).toBe(true);
  }
  const a=structuredClone(response),b=structuredClone(response);a.result.page.total=2;a.result.page.next_cursor='cursor-demo';a.result.items[0].total_bytes=12;
  b.result.page.total=2;b.result.page.offset=1;b.result.items[0]={...a.result.items[0],fragment_id:'fragment-two',offset_bytes:10,text:'é'};
  for(const helper of [validatePageContinuation,portable.validatePageContinuation]){
    expect(helper(a,b).valid).toBe(true);expect(helper(a,{...b,result:{...b.result,turn_id:'foreign-turn'}}).valid).toBe(false);
    const wrong=structuredClone(b);wrong.result.items[0].offset_bytes=9;expect(helper(a,wrong).valid).toBe(false);
  }
});
