// Opt-in physical SDK/CLI qualification against a loopback synthetic provider.
// No credentials, inference, downloads or ordinary user profile are used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const sdk = process.env.MACRO_CLAUDE_SDK, cli = process.env.MACRO_CLAUDE_CLI;
assert(sdk && cli, 'Set explicit external SDK and CLI paths. This script never installs them.');
const directory = await mkdtemp(join(tmpdir(), 'macro-claude-runner-'));
for (const name of ['home','cache','config','workspace','tmp']) await mkdir(join(directory,name),{ mode:0o700 });
await writeFile(join(directory,'AGENTS.md'),'FOREIGN_AGENT_CONTEXT_MUST_NOT_APPEAR');
await writeFile(join(directory,'CLAUDE.md'),'FOREIGN_CLAUDE_CONTEXT_MUST_NOT_APPEAR');
await mkdir(join(directory,'workspace','.claude'));
await writeFile(join(directory,'workspace','.claude','settings.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:`touch ${join(directory,'forbidden-hook')}`}]}]}}));
const exact = `{"large":9007199254740993,"decimal":0.10000000000000000001,"text":${JSON.stringify('é'.repeat(1200))}}`;
let mode, requests = [], calls = [], results = [];
function sse(res, content, n) {
  const emit = (event,data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.writeHead(200,{'content-type':'text/event-stream'});
  emit('message_start',{type:'message_start',message:{id:`msg_${n}`,type:'message',role:'assistant',model:'claude-haiku-5-5',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}}});
  content.forEach((block,index)=>{
    emit('content_block_start',{type:'content_block_start',index,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}});
    emit('content_block_delta',{type:'content_block_delta',index,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}});
    emit('content_block_stop',{type:'content_block_stop',index});
  });
  emit('message_delta',{type:'message_delta',delta:{stop_reason:content.some(b=>b.type==='tool_use')?'tool_use':'end_turn',stop_sequence:null},usage:{input_tokens:100,output_tokens:20}});
  emit('message_stop',{type:'message_stop'});res.end();
}
const server = http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const value=JSON.parse(body);requests.push({url:req.url,body:value});
  if(req.url.includes('count_tokens')) {res.end('{"input_tokens":100}');return;}
  const n=requests.filter(r=>!r.url.includes('count_tokens')).length;
  const content=mode==='native-deny' && n===1 ? [{type:'tool_use',id:'native-denied',name:'Bash',input:{command:'printf forbidden'}}]
    : mode!=='native-deny' && n<=2 ? [{type:'tool_use',id:`tool_${n}`,name:n===1?'mcp__macro__echo':'mcp__macro__macro_agsdl_publish',input:{argumentsJson:exact}}]
    : [{type:'text',text:'Synthetic fixture complete.'}];
  sse(res,content,n);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const report={directory,realInference:false,cases:[]};
async function run(currentMode, sessionId, resume=false) {
  mode=currentMode;requests=[];calls=[];results=[];
  const frames=[];let ready, terminal;
  const child=spawn(process.execPath,[resolve('src-tauri/src/agsdl_host_claude/runner.mjs')],{
    detached:true,stdio:['pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',HOME:join(directory,'home'),XDG_CACHE_HOME:join(directory,'cache'),CLAUDE_CONFIG_DIR:join(directory,'config'),TMPDIR:join(directory,'tmp'),LANG:'C.UTF-8',ANTHROPIC_API_KEY:'sk-ant-synthetic-inert-loopback',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_MAX_OUTPUT_TOKENS:'1024',ENABLE_TOOL_SEARCH:'false',CLAUDE_CODE_DISABLE_ADVISOR_TOOL:'1',CLAUDE_CODE_DISABLE_WORKFLOWS:'1',CLAUDE_CODE_DISABLE_AGENT_VIEW:'1',CLAUDE_CODE_DISABLE_TERMINAL_TITLE:'1',CLAUDE_CODE_MAX_RETRIES:'0',DISABLE_DOCTOR_COMMAND:'1',CLAUDE_CODE_DISABLE_CLAUDE_MDS:'1',CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS:'1',CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK:'1',CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',CLAUDE_CODE_DISABLE_POLICY_SKILLS:'1',CLAUDE_CODE_DISABLE_CRON:'1',CLAUDE_CODE_DISABLE_ARTIFACT:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1',CLAUDE_CODE_DISABLE_FILE_MENTIONS:'1',CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false',CLAUDE_CODE_DISABLE_BUNDLED_SKILLS:'1'}
  });
  let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const input=createInterface({input:child.stdout});
  const send=value=>child.stdin.write(`${JSON.stringify(value)}\n`);
  const config={sdk,zod:join(dirname(dirname(dirname(sdk))),'zod'),cli,sdkVersion:'0.3.308',cliVersion:'2.1.308',cwd:join(directory,'workspace'),sessionId,resume,userMessageUuid:randomUUID(),model:'claude-haiku-5-5',initialization:'Synthetic transport fixture.',input:'/doctor @fixture remains literal. Synthetic fixture.',tools:[{name:'echo',description:'Synthetic echo.'}],publication:true,maxTurns:3,effort:'low',qa:true,diagnostic:false};
  send({method:'configure',params:config});
  const timeout=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},30_000);
  try {
    for await(const line of input) {
      const frame=JSON.parse(line);frames.push(frame);
      if(frame.method==='nativeExit') continue;
      if(frame.method==='fatal') break;
      if(frame.method==='ready') {ready=frame.params;assert.equal(requests.length,0,'model request preceded host readiness');}
      if(frame.method==='tool' || frame.method==='publish') {
        calls.push(frame.params);assert.equal(frame.params.argumentsJson,exact,'exact arguments changed');
        if(currentMode==='lost-response') {break;}
        send({id:frame.id,result:{resultJson:currentMode==='host-deny'?'Synthetic Macro refusal':exact,failed:currentMode==='host-deny'}});
      } else {
        send({id:frame.id,result:{}});
        if(frame.method==='frame' && frame.params.frame.type==='result') {terminal=frame.params.frame;break;}
      }
    }
  } finally {
    clearTimeout(timeout);input.close();child.stdin.end();
    try{process.kill(-child.pid,'SIGTERM');}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
    try{process.kill(-child.pid,'SIGKILL');}catch{}
  }
  const entry={mode:currentMode,resume,sessionId,ready,terminal,frames,calls,requests,stderr};report.cases.push(entry);
  if(currentMode==='missing-session') {assert(!ready);assert(!terminal);assert.equal(requests.length,0);return;}
  assert(ready,'SDK initialization failed');
  assert.deepEqual(ready.initialized.agents,[],'native agents remain');
  const modelRequests=requests.filter(r=>!r.url.includes('count_tokens'));
  assert(modelRequests.every(r=>r.body.max_tokens===1024),'output token limit changed');
  assert(modelRequests.every(r=>r.body.output_config?.effort==='low'),'effort translation changed');
  assert(modelRequests.every(r=>!JSON.stringify(r.body).includes('FOREIGN_AGENT_CONTEXT_MUST_NOT_APPEAR') && !JSON.stringify(r.body).includes('FOREIGN_CLAUDE_CONTEXT_MUST_NOT_APPEAR')),'foreign context was loaded');
  assert(modelRequests.every(r=>r.body.tools.every(t=>['mcp__macro__echo','mcp__macro__macro_agsdl_publish'].includes(t.name))),'unexpected native tool');
  if(currentMode==='lost-response') {assert.equal(calls.length,1);return;}
  assert(terminal,'missing native result');
  await assert.rejects(access(join(directory,'forbidden-hook')));
  const init=frames.find(f=>f.params?.frame?.type==='system' && f.params.frame.subtype==='init')?.params.frame;
  assert.equal(init.session_id,sessionId);
  assert.deepEqual(init.tools,['mcp__macro__echo','mcp__macro__macro_agsdl_publish']);
  assert.deepEqual(init.agents,[]);assert.deepEqual(init.skills,[]);assert.deepEqual(init.plugins,[]);
  if(currentMode==='native-deny') {assert.equal(calls.length,0);assert(modelRequests.some(r=>JSON.stringify(r.body.messages).includes('No such tool available: Bash')));}
  else {assert.deepEqual(calls.map(c=>c.toolUseId),['tool_1','tool_2']);assert(calls.every(c=>c.argumentsJson===exact));}
}
try {
  const session=randomUUID();await run('success',session);await run('success',session,true);
  await run('host-deny',randomUUID());await run('native-deny',randomUUID());
  await run('lost-response',randomUUID());await run('missing-session',randomUUID(),true);
  assert.deepEqual(await readdir(join(directory,'home')),[], 'CLI wrote outside its explicit private cache');
  report.homeRemainedEmpty=true;
  console.log(JSON.stringify({realInference:false,cases:report.cases.map(c=>({mode:c.mode,resume:c.resume,requests:c.requests.length,calls:c.calls.length,result:c.terminal?.subtype})),report:process.env.MACRO_CLAUDE_QUALIFICATION_REPORT || join(directory,'report.json')}));
} finally {
  server.closeAllConnections();server.close();
  await writeFile(process.env.MACRO_CLAUDE_QUALIFICATION_REPORT || join(directory,'report.json'),JSON.stringify(report,null,2));
}
