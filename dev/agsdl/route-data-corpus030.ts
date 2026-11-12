// Synthetic captures and pinned authored fixtures. No effects or real profiles.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compilePlan030 } from '../../src/services/agsdlExecution/compiler030';
import { decode, encode, record } from '../../src/services/agsdlExecution/exact';
import type { CapturedRegistry030 } from '../../src/services/agsdlExecution/contracts030';
import type { SourceRevision, ExactJsonText } from '../../src/services/agsdlExecution/contracts';
export async function buildRouteDataCorpus030() {
  const cases: { id: string; family: string; request: { op: string; json: string } }[] = [];
  const files: { path: string; sha256: string }[] = [];
  const seen = new Set<string>();
  function add(family: string, op: string, input: unknown, raw?: [string, string]) {
    let json = JSON.stringify(input); if (raw) json = json.replaceAll(JSON.stringify(raw[0]), raw[1]);
    const key = op + ':' + json; if (seen.has(key)) return; seen.add(key);
    cases.push({ id: `${family}:${cases.length}`, family, request: { op, json } });
  }
  const copy = <T>(v: T): T => structuredClone(v);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const j = (s: string) => s as ExactJsonText;
  const caps = ['result-submission','agent-continuity','continuity','permission-enforcement','contained-stop','response-attribution','completion-check','resources','model.name','model.effort','skills','mcpServers','plan','planFirst.auto','planFirst.ask','reviewer.person','reviewer.model','directories','instance.new','delivery.steer','delivery.queue','instructions','answer-timeout','harness-settings'];
  async function plan(authored: string) {
    const doc = record(decode(authored)), evidence = j('{"synthetic":"route-data"}');
    const registry: CapturedRegistry030 = { format: 'macro-agsdl-registry/030', version: 'synthetic', modules: [],
      hostCapabilities: ['call.command','call.mcp','approval'].map(name => ({ name, support: 'native', evidenceJson: evidence })),
      harnesses: [...new Set(Object.values(record(doc.agents)).map(a => String(record(a).harness)))].map(harness => ({ harness, version: '1.0.0', installation: 'available', adapterId: 'synthetic', qualified: true, defaultModel: 'test/model', models: [{ name: 'test/model', efforts: [], defaultEffort: null }], capabilities: caps.map(name => ({ name, support: 'native', evidenceJson: evidence })) })),
      agents: Object.entries(record(doc.agents)).map(([agentName, declaration]) => ({ agentName, agentDeclarationJson: encode(declaration), settingsJson: j('{}'), permissionsJson: j('{"preset":"read-only"}'), scopeJson: j('{"workspace":"/synthetic"}'), evidenceJson: evidence, provenanceJson: j('{"entries":[]}') })) };
    const source: SourceRevision = { owner: { projectId: 'synthetic', planId: 'synthetic', branch: 'feature/synthetic' }, revision: '1', sourceSha256: sha(authored) as SourceRevision['sourceSha256'] };
    const out = await compilePlan030(authored, source, registry);
    if (!out.compiledPlanJson) throw new Error('Corpus compilation failed: ' + JSON.stringify(out));
    return out.compiledPlanJson;
  }
  const source = { kind: 'entry', terminalId: 'terminal', producerStep: ['call'], outputJson: '{"data":{"n":9007199254740993,"xs":[null,1e400],"__proto__":"literal"}}', provenance: { instructions: [] } };
  const numbers = ['0','-0','0e9999','1','-1','1.0','1e2','1.25','9007199254740993','1e400','-1e-400'];
  for (const parse of [undefined,'lines','json']) for (const stdout of ['', 'A\r\n\n \nB\rC\nlast\r','null','true','"text"','9007199254740993','{"n":1E+2,"2":-0,"1":1.00}','[1,null]','1 2','{"a":1,"a":2}','{bad}','"\ud800"']) for (const code of numbers) {
    const input = { prepared: { kind: 'command', command: '$literal ${data.n}', ...(parse ? { parse } : {}) }, receipt: { stdout, stderr: 'stderr', output: stdout + 'stderr', exitCodeJson: code, complete: true } };
    add('command-export', 'command', input);
    if (['0','1','-1'].includes(code)) add('command-native', 'callData', { operation: 'normalize', ...input });
  }
  for (const complete of [false,null,0,'',true]) for (const exitCodeJson of ['{}','null','"1"','1.1','{','1.1.']) add('command-guards','command',{prepared:{kind:'command',parse:'json'},receipt:{complete,exitCodeJson,stdout:'{bad}',output:'both'}});
  for (const text of ['', 'original\ntext', '\ud800', '\udc00', '𝄞\u2028\u0000']) for (const isError of [false,true]) for (const structuredContentJson of [undefined,'null','false','""','{}','9007199254740993','{"z":1E+2,"a":-0}','{','{"a":1,"a":2}']) {
    const receipt = { text,isError,...(structuredContentJson === undefined ? {} : { structuredContentJson }) };
    add('mcp-export','mcp',{receipt}); add('mcp-native','callData',{operation:'normalize',prepared:{kind:'mcp',server:'s',tool:'t',argumentsJson:'{}'},receipt});
  }
  const steps = ['{"type":"call","command":"echo $DATA ${data.n}"}','{"type":"call","command":"x","parse":"lines"}','{"type":"call","mcp":{"server":"s","tool":"t"}}','{"type":"call","mcp":{"server":"s","tool":"t"},"arguments":null}',
    ...['{}','{"path":["data","n"]}','{"path":["data","xs",0e20]}','{"path":["data","xs","0"]}','{"path":[]}','{"path":["missing"]}','{"value":{"uri":"literal","ref":"literal"}}','{"value":-0,"path":[]}'].map(operand => `{"type":"call","mcp":{"server":"s","tool":"t"},"arguments":{"2":{"value":1.00},"1":${operand},"__proto__":{"value":null}}}`),
    '{}','{"type":"agent"}','{"type":"call"}','{"type":"call","command":"x","mcp":{}}','{"type":"call","command":null}','{"type":"call","command":"x","arguments":{}}','{"type":"call","command":"x","answerTimeoutMs":1}','{"type":"call","command":"x","parse":"bad"}','{"type":"call","mcp":{"server":"s","tool":"t","extra":true}}','{"type":"call","mcp":{"server":"s","tool":"t"},"parse":"json"}'];
  for (const stepJson of steps) for (const outputJson of [source.outputJson,'{','null']) {
    add('call-prepare','prepareCall',{stepJson,source:{...source,outputJson}});
    add('call-prepare-native','callData',{operation:'prepare',stepJson,source:{...source,outputJson}});
  }
  const identity = { captureId:'capture',sourceDigest:'digest',agent:'worker',policyDigest:'policy' };
  const sourceJson = '{"uri":"guide.txt","mediaType":"text/plain"}';
  const use = { usage:'prompt',pointer:'/message/prompt/0' };
  const receipt = { sourceJson,payload:{kind:'text',text:'Captured'},provenance:{...identity,...use,requestedUri:'guide.txt',mediaType:'text/plain',sha256:'a'.repeat(64)} };
  for (const payload of [{kind:'text',text:''},{kind:'text',text:'\ud800'},{kind:'text',text:'𝄞\u2028'},{kind:'media',base64:'AAEC/w=='},...['null','9007199254740993','{"2":1.00,"1":-0}','{'].map(json=>({kind:'json',json}))]) add('content-payload','content',{identity,receipts:[{...receipt,payload}],sourceJson,use});
  for (const field of ['captureId','sourceDigest','agent','policyDigest','pointer','usage','requestedUri','sha256']) for (const value of ['',null,'wrong','a'.repeat(64)+'\n']) {
    add('content-correlation','content',{identity,receipts:[{...receipt,provenance:{...receipt.provenance,[field]:value}}],sourceJson,use});
  }
  for (const receipts of [[],[receipt],[receipt,receipt],[{...receipt,sourceJson:'{'}],[{...receipt,sourceJson:'{"uri":"other"}'},receipt],[{...receipt,sourceJson:'{ "mediaType":"text/plain", "uri":"guide\\u002etxt" }'}]]) add('content-selection','content',{identity,receipts,sourceJson,use});
  for (const raw of ['{}','{"value":{"uri":"literal","ref":"x"}}','{"value":-0,"uri":"ignored"}','{"uri":1}','"x"','{"value":"\ud800"}']) add('content-inline','content',{identity,receipts:[],sourceJson:raw,use});
  const occurrence = {targetOrdinal:1,itemIndex:'0',contextId:'context',identity,receipts:[receipt]};
  const cache = {format:'macro-agsdl-route-content/1',occurrences:[occurrence]};
  for (const ordinal of [-1,-0,0,1,1.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,null,'1']) for (const index of ['0','1','00','-0','0\n','1\r',0,null]) add('occurrence-guards','occurrence',{cache:{...cache,occurrences:[{...occurrence,targetOrdinal:ordinal,itemIndex:index}]},ordinal:1,index:'0',sourceJson,use});
  for (const contextId of ['',null,0,' ','\ud800']) add('occurrence-context','occurrence',{cache:{...cache,occurrences:[{...occurrence,contextId}]},ordinal:1,index:'0',sourceJson,use});
  for (const modified of [{...cache,occurrences:[occurrence,occurrence]},{...cache,occurrences:[occurrence,{...occurrence,itemIndex:'1'}]},{...cache,occurrences:[occurrence,{...occurrence,itemIndex:'1',contextId:'second'}]}, {identity,receipts:[]},{identity,receipts:[receipt]},{identity:[],receipts:[]},{format:'wrong',occurrences:[]},{format:'macro-agsdl-route-content/1',occurrences:null}]) add('occurrence-selection','occurrence',{cache:modified,ordinal:1,index:'0',sourceJson,use});
  const authored = JSON.stringify({contract:'agsdl-0.3.0',id:'route-data',agents:{lead:{harness:'synthetic',permissions:'read-only',results:{xs:{schema:{type:'array',items:{type:'number'}}}}},worker:{harness:'synthetic',permissions:'read-only'}},content:{guide:{uri:'guide.txt',mediaType:'text/plain'}},flow:{entry:'lead',steps:{lead:{type:'agent',agent:'lead',next:{step:'worker',each:['results','xs'],max:2,message:{prompt:[{ref:'guide'}]}},onError:'worker'},worker:{type:'agent',agent:'worker',prompt:'Fallback'}}}});
  const planJson = await plan(authored);
  const base = { planJson, reference:{route:{source:['lead'],kind:'normal',key:null}},producer:{activationId:'terminal',step:['lead'],kind:'agent',inputJson:'{}',messageJson:null,itemJson:null,outputJson:'{"text":"","results":{"xs":[1,1]}}'},source:{kind:'agent',terminalId:'terminal',producerStep:['lead'],producerAgent:'lead',outputJson:'{"text":"","results":{"xs":[1,1]}}',provenance:{instructions:[]}},nativeReceiptId:'receipt'};
  const emptyCache = {format:'macro-agsdl-route-content/1',occurrences:[]};
  const routeInputs:any[] = [base,{...base,deferPromptUris:true},{...base,shared:{identity,receipts:[receipt]}},{...base,cache:emptyCache},{...base,cache:{...cache,occurrences:[{...occurrence,targetOrdinal:0},{...occurrence,targetOrdinal:0,itemIndex:'1',contextId:'second',receipts:[{...receipt,payload:{kind:'text',text:'Second'}}]}]}}];
  for (const xs of [[],[1],[1,1],[1,2,3],null,'wrong']) {const outputJson=JSON.stringify({text:'',results:{xs}});routeInputs.push({...base,producer:{...base.producer,outputJson},source:{...base.source,outputJson},deferPromptUris:true});}
  for (const field of ['nativeReceiptId','planJson']) for (const value of ['',null,'{}','{']) routeInputs.push({...base,[field]:value});
  for (const field of ['activationId','step','kind','outputJson']) routeInputs.push({...base,producer:{...base.producer,[field]:field==='step'?['missing']:'wrong'}});
  for (const field of ['terminalId','producerStep','producerAgent','kind','outputJson']) routeInputs.push({...base,source:{...base.source,[field]:field==='producerStep'?['missing']:'wrong'}});
  for (const field of ['source','kind','key']) routeInputs.push({...base,reference:{route:{...base.reference.route,[field]:field==='source'?['missing']:'wrong'}}});
  const mutations = [(p:any)=>p.format='wrong',(p:any)=>p.routes.push(copy(p.routes[0])),(p:any)=>p.scopes.push(copy(p.scopes[0])),(p:any)=>p.routes[0].targets[0].address=['lead'],(p:any)=>p.routes[0].declarationJson='"missing"',(p:any)=>p.steps[0].scope=['missing'],(p:any)=>p.steps=null];
  for (const mutate of mutations){const p=JSON.parse(planJson);mutate(p);routeInputs.push({...base,planJson:JSON.stringify(p)});}
  for (const extra of [1,Number.POSITIVE_INFINITY,'\ud800',{'2':true,'1':false,z:null}]) routeInputs.push({...base,deferPromptUris:true,producer:{...base.producer,extra},source:{...base.source,extra}});
  const broker=(input:unknown,generation='generation')=>({job:{ticket:'ticket',generation,inputDigest:'digest',inputJson:JSON.stringify(input)}});
  for (const input of routeInputs){add('route-preparation','route',input);const {cache:captures,shared:_shared,...rest}=input;add('route-broker','broker',broker({...rest,contentReceipts:captures??emptyCache}));}
  for (const raw of ['null','false','[]','{}','{','1.1.']) add('broker-priority','broker',{job:{ticket:'ticket',generation:'generation',inputDigest:'digest',inputJson:raw}});
  add('broker-generation','broker',broker({},'retired'));
  for (const input of [{operation:'prepare',stepJson:'{}',source},{operation:'normalize',prepared:{kind:'command'},receipt:{complete:false}},{operation:'normalize',prepared:{kind:'mcp'},receipt:{text:'original',isError:false}},{operation:'other',...base,contentReceipts:emptyCache,content:{bad:true},contentForOccurrence:{bad:true}}]) add('broker-operation','broker',broker(input));
  for (const name of readdirSync('dev/agsdl/fixtures/v0.3/conformance/runs').sort()) {
    const path='dev/agsdl/fixtures/v0.3/conformance/runs/'+name, raw=readFileSync(path,'utf8');files.push({path,sha256:sha(raw)});
    const document=record(decode(raw)).document;const compiled=await plan(encode(document));const p=JSON.parse(compiled);
    for (const route of p.routes) {
      const sourceStep=p.steps.find((s:any)=>JSON.stringify(s.address)===JSON.stringify(route.source));
      const producerStep=sourceStep.type==='compose'?p.steps.find((s:any)=>s.type!=='compose'&&s.address.length>route.source.length&&route.source.every((part:string,i:number)=>part===s.address[i])):sourceStep;
      if (!producerStep) throw new Error('Missing corpus producer');
      const kind=producerStep.type;
      const outputJson=route.kind==='error'?'{"error":{"code":"SYNTHETIC","message":"Synthetic","details":[]}}':JSON.stringify(kind==='agent'?{text:'Synthetic',results:{},instructions:'Mission',...(route.key?{choice:route.key}:{})}:kind==='approval'?{choice:route.key??'yes',comment:'Synthetic',message:{prompt:'Synthetic'}}:{outcome:route.key??'passed',data:{}});
      const input={planJson:compiled,reference:{route:{source:route.source,kind:route.kind,key:route.key}},producer:{activationId:'terminal',step:producerStep.address,kind,inputJson:'{}',messageJson:kind==='approval'?'{"prompt":"Synthetic"}':null,itemJson:null,outputJson},source:{terminalId:'terminal',producerStep:producerStep.address,...(kind==='agent'?{producerAgent:producerStep.agent}:{}),kind:route.kind==='error'?'error':kind,outputJson,provenance:{instructions:kind==='agent'?[{pathJson:'["instructions"]',producerAgent:producerStep.agent,terminalId:'terminal'}]:[]}},nativeReceiptId:'receipt',deferPromptUris:true,contentReceipts:emptyCache};
      add('pinned-routes','broker',broker(input));
    }
  }

  // Instruction guards, compound defects and nested effective recipients.
  const missionDoc = JSON.stringify({contract:'agsdl-0.3.0',id:'missions',agents:{lead:{harness:'synthetic',permissions:'read-only',instructs:true},worker:{harness:'synthetic',permissions:'read-only'}},flow:{entry:'lead',steps:{lead:{type:'agent',agent:'lead',next:{split:{step:'worker',each:['instructions'],max:2},done:'worker'}},worker:{type:'agent',agent:'worker',prompt:'Fallback'}}}});
  const missionPlan=await plan(missionDoc);
  for (const key of ['split','done']) for (const instructions of [undefined,null,'Mission',[],['same','same'],['a','b','c'],1]) for (const authorized of [false,true]) {
    const outputJson=JSON.stringify({text:'Original',results:{},...(instructions===undefined?{}:{instructions}),choice:key});
    const input={...base,planJson:missionPlan,reference:{route:{source:['lead'],kind:'normal',key}},producer:{...base.producer,outputJson},source:{...base.source,outputJson,provenance:{instructions:authorized?[{pathJson:'["instructions"]',producerAgent:'lead',terminalId:'terminal',extra:{'2':true,'1':false}}]:[]}}};
    add('route-instructions','route',input);
  }
  for (const token of ['-0','9007199254740993','1e400','-1e-400']) add('route-native-numbers','route',{...base,deferPromptUris:true,source:{...base.source,extra:'$native'},producer:{...base.producer,extra:'$native'}},['$native',token]);
  for (const defective of [null,{...receipt,provenance:null},{...receipt,payload:null},{...receipt,sourceJson:'{'},{...receipt,payload:{kind:'json',json:'{'}}]) {
    const captures={format:'macro-agsdl-route-content/1',occurrences:[{...occurrence,targetOrdinal:0,receipts:[defective]}]};
    add('broker-content-errors','broker',broker({...base,contentReceipts:captures}));
  }
  for (const bad of ['{','{"uri":"other"}']) add('content-priority','content',{identity:{...identity,agent:'wrong'},receipts:[{...receipt,sourceJson:bad},receipt],sourceJson,use});
  const nestedDoc = JSON.stringify({
    contract: 'agsdl-0.3.0', id: 'nested',
    agents: { worker: { harness: 'synthetic', permissions: 'read-only' } },
    compositions: {
      inner: { entry: 'approval', outputs: ['done'], steps: {
        approval: { type: 'approval', next: { yes: { output: 'done' } }, onError: { output: 'done' } },
      } },
      outer: { entry: 'inner', outputs: ['done'], steps: {
        inner: { type: 'compose', composition: 'inner', next: { done: { output: 'done' } } },
      } },
    },
    flow: { entry: 'outer', steps: {
      outer: { type: 'compose', composition: 'outer', next: { done: 'after' } },
      after: { type: 'agent', agent: 'worker', prompt: 'Fallback' },
    } },
  });
  const nestedPlan=await plan(nestedDoc);
  for (const failure of [null,'APPROVAL_TIMEOUT','VISIT_LIMIT']) for (const messageJson of [null,'{"prompt":"Review"}','{"prompt":"Other"}','{']) {
    const outputJson=JSON.stringify(failure?{error:{code:failure,message:failure,details:[]}}:{choice:'yes',comment:'Comment',message:{prompt:'Review'}});
    const input={...base,planJson:nestedPlan,reference:{route:{source:['outer'],kind:'normal',key:'done'}},producer:{...base.producer,step:['outer','inner','approval'],kind:'approval',messageJson,outputJson},source:{kind:failure?'error':'approval',terminalId:'terminal',producerStep:['outer','inner','approval'],outputJson,provenance:{instructions:[],prompt:{kind:'host',extra:{'2':true,'1':false}}}}};
    add('route-composition','route',input);
    add('broker-composition','broker',broker({...input,contentReceipts:emptyCache}));
  }
  const recipientDoc=JSON.stringify({contract:'agsdl-0.3.0',id:'recipients',agents:{worker:{harness:'synthetic',permissions:'read-only'}},compositions:{body:{entry:'work',outputs:['done'],steps:{work:{type:'agent',agent:'worker',next:{output:'done'}}}}},flow:{entry:'call',steps:{call:{type:'call',command:'literal',next:{step:'body',message:{prompt:[{uri:'file:///synthetic/mission.txt'}]}}},body:{type:'compose',composition:'body',next:{done:[]}}}}});
  const recipientPlan=await plan(recipientDoc);
  const callOutput='{"outcome":"passed","data":{}}';
  const recipientInput={...base,planJson:recipientPlan,reference:{route:{source:['call'],kind:'normal',key:null}},producer:{...base.producer,step:['call'],kind:'call',outputJson:callOutput},source:{kind:'call',terminalId:'terminal',producerStep:['call'],outputJson:callOutput,provenance:{instructions:[]}}};
  for (const deferPromptUris of [false,true,'true',null]) add('route-recipient','route',{...recipientInput,deferPromptUris});
  for (const mutation of [(p:any)=>p.steps.find((s:any)=>s.address.join('/')==='body/work').type='approval',(p:any)=>p.scopes.find((s:any)=>s.address.join('/')==='body').entry=['body'],(p:any)=>p.scopes.find((s:any)=>s.address.join('/')==='body').entry=['missing']]) {
    const p=JSON.parse(recipientPlan);mutation(p);add('route-recipient','route',{...recipientInput,planJson:JSON.stringify(p),deferPromptUris:true});
  }
  return {seed:'route-data-030-v1',minimums:{'command-guards':30,'command-export':300,'command-native':100,'mcp-export':60,'mcp-native':60,'call-prepare':50,'call-prepare-native':50,'content-payload':8,'content-correlation':25,'content-selection':6,'content-inline':6,'occurrence-guards':60,'occurrence-context':5,'occurrence-selection':8,'route-preparation':35,'route-broker':35,'broker-priority':6,'broker-generation':1,'broker-operation':4,'pinned-routes':100,'route-instructions':28,'route-native-numbers':4,'broker-content-errors':5,'content-priority':2,'route-composition':12,'broker-composition':12,'route-recipient':7},files,cases};
}
