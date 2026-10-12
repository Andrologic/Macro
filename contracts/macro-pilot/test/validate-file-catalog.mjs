import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateMessage, validateExchange } from '../v2/validate.mjs';
const fixture=async name=>JSON.parse(await readFile(new URL(`../v2/fixtures/valid/${name}.json`,import.meta.url),'utf8'));
const request=await fixture('request-conversation.files.list');
const response=await fixture('response-conversation.files.list');
assert.equal(response.result.items.length,1);
assert.equal(response.result.items[0].content_state,'available');
assert.equal('patch_bytes' in response.result.items[0],false);
assert.equal(validateMessage(response).valid,true);
assert.equal(validateExchange(request,response).valid,true);
const diff=await fixture('response-diff.files');
assert.equal(validateMessage(diff).valid,true);
for(const change of [item=>{item.content_state='withheld';item.patch_bytes=1;},item=>{item.old_path='.env';item.new_path='.env';},item=>{item.old_path=null;item.new_path=null;}]){
 const wrong=structuredClone(diff);change(wrong.result.items[0]);assert.equal(validateMessage(wrong).valid,false);
}
console.log('Nonempty conversation file catalogue accepted; diff patch-state and protected-path rejection preserved.');
