// Deterministic work vectors. Captures from the live conformance pump are a
// separate corpus, with their original identities and byte strings intact.
import { createAgentWorkContract030 } from '../../src/services/agsdlExecution/agentWorkContracts030';
import { evaluateHostWork030 } from '../../src/services/agsdlExecution/hostWorkTransition030';
import { EMPTY_WORK_JOURNAL030 } from '../../src/services/agsdlExecution/hostWorkJournal030';
import { connectValueSchemaValidator030 } from '../../src/services/agsdlExecution/valueSchemaPort030';
import { NumberToken, parse } from '../../src/vendor/agsdl/v0.4/json.mjs';
import { validate } from '../../src/vendor/agsdl/v0.4/valueschema.mjs';
import type { ExactJsonText } from '../../src/services/agsdlExecution/contracts';
import type { WorkRequest030 } from './work-oracle030';
export const WORK_SEED030 = 'work-030-20261112-v1';
export const WORK_MINIMUMS030: Record<string, number> = { submission: 100, controller: 100, plan: 20, check: 100, nativeSyntax: 100, journal: 40, visible: 5, options: 50, attribution: 5, generated: 256, mutations: 6, syntaxDot: 52, syntaxDotJournal: 9 };
interface Case { family: string; request: WorkRequest030 }
type Input = Record<string, unknown>;
const owner = { systemStartId: 'run', activationId: 'work', agentInstanceId: 'agent', ownerEpoch: 'epoch' };
const options = { checkTimeoutMs: '1000', maxCheckOutputBytes: 5, enforcedPlanLock: true };
const context = { owner: { systemStartId: 'run', ownerEpoch: 'epoch' }, work: { systemStartId: 'run', flowInvocationId: 'flow', activationId: 'work', step: ['task'], agentInstanceId: 'agent' }, permissionsJson: '{}', scopeJson: '{}', registryVersion: 'registry' };
const validator = connectValueSchemaValidator030({ NumberToken, parse, validate });
const step = (event: Input, id: string) => ({ id, event });
export function buildWorkCorpus030(): Case[] {
    const cases: Case[] = [];
    const add = (family: string, op: WorkRequest030['op'], value: unknown) => cases.push({ family, request: { op, json: JSON.stringify(value) } });
    const ctrl = (family: string, agent: string, steps: unknown[], extra: Input = {}) => add(family, 'controller', { owner, options, agent, steps, ...extra });
    const submit = (raw: string, id = 'call') => step({ kind: 'submit', callId: id, argumentsJson: raw }, id);
    const physical = (providerEnded = true, effectsEnded = true) => step({ kind: 'physicalEnded', providerEnded, effectsEnded }, `physical-${providerEnded}-${effectsEnded}`);
    const check = (exitCode: unknown, extra: Input = {}) => step({ kind: 'checkEnded', checkId: 'work:check:1', physicalState: 'ended', exitCode, stdout: '', stderr: '', ...extra }, 'check');
    const agents = [ '{}', '{"results":{"x":{}}}', '{"results":{"x":{"required":true}}}', '{"results":{"x":{"schema":{"type":"integer"}}}}', '{"instructs":true}', '{"maxCorrections":0}', '{"maxCorrections":1e999999999999999999999}', '{"completionCheck":{"command":"test"}}' ];
    const raws = ['{}','null','[]','1','"x"','{','{"results":{},"results":{}}','{"unknown":1}','{"results":null}','{"results":{"x":9007199254740993}}','{"results":{"x":1.0}}','{"results":{"x":1e999}}','{"results":{"x":-0}}','{"results":{"x":"wrong","other":0}}','{"choice":"yes"}','{"instructions":"mission"}','{"instructions":[]}','{"results":{"x":"\\ud800"}}','{"results":{"x":"\ud800"}}'];
    for (const agent of agents) {
        add('submission', 'requires', { agent });
        for (const raw of raws) {
            add('submission', 'submission', { agent, raw });
            ctrl('controller', agent, [submit(raw), { kind: 'snapshot' }, physical(false), physical(), { kind: 'allows', effect: 'change' }]);
        }
    }
    for (const schema of [ { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false }, { type: 'array', items: { type: 'integer', enum: [1, 2] } }, { type: 'string', enum: ['é😀', 'ok'] }, { type: 'number', enum: [1, 1.5, 3] } ]) {
        const agent = JSON.stringify({ results: { 'a/~𝄞': { required: true, schema } } });
        for (const value of ['null', '{}', '{"n":1.5,"extra":0}', '[]', '[1,3]', '"é😀"', '1.5', '1e999', '-0']) add('submission','submission',{ agent, raw: `{"results":{"a/~𝄞":${value}}}` });
    }
    for (const mediaType of ['text/plain', 'application/json', 'application/geo+json', 'image/png']) {
        const agent = JSON.stringify({ results: { file: { mediaType, required: true } } });
        for (const value of ['file:///workspace/x', 'https://example.test/a', 'urn:x:y', 'data:text/plain,hello', '../x', 'file:///x%ZZ', 'https://x:99999', 'https://é.test/x', 'a:hi\uFEFF', 'file:///space here', '', '\ud800', null, 1]) add('submission','submission',{agent,raw:JSON.stringify({results:{file:value}})});
    }
    for (const route of ['none','string','list'] as const) for (const choice of ['a','b','unknown',null]) for (const instruction of [undefined, '', ['a','b'], [], null, 1]) {
        const contractInput = { agentJson: '{"instructs":true,"completionCheck":{"command":"test","choices":["a"]}}', choices: ['a','b'], instructionsByChoice: {a:route},defaultInstructions:'none' };
        add('submission','submission',{contractInput,raw:JSON.stringify({choice,instructions:instruction})});
    }
    for (const reason of ['OUTPUT_INVALID','CHECK_FAILED','PLAN_REJECTED','TIMEOUT','STOPPED','REVOKED','AGENT_FAILED','HARNESS_REFUSED','INTERRUPTED','JOIN_CANCELLED']) {
        const accepted = {kind:'submit',callId:'accepted',argumentsJson:'{}'};
        ctrl('controller','{}',[step(accepted,'accepted'),step({kind:'stop',reason},'stop'),step(accepted,'accepted'),step(accepted,'alias'),submit('{}','late'),submit('{}','late'),submit('{ }','late'),physical(false),physical(),step({kind:'turnEnded',turnId:'after'},'after')]);
    }
    for (let n=0;n<20;n++) {
        const steps:unknown[]=[];
        for(let i=0;i<6;i++) {steps.push(submit(i%2?'{}':'{"unknown":1}',`call-${i}`));steps.push({kind:'snapshot'});}
        ctrl('controller',`{"maxCorrections":${n}}`,steps);
        ctrl('controller','{}',[submit('{"unknown":1}','one'),{kind:'snapshot',mutate:{state:'finished'}},submit('{"unknown":1}','one')],{contract:JSON.parse(JSON.stringify(createAgentWorkContract030({agentJson:'{}' as ExactJsonText}))),mutateOptions:{maxCheckOutputBytes:0},mutateContract:{maxCorrections:'0'}});
    }
    for (const mode of ['auto','ask',null]) for(const comment of [undefined,'','Revise','\uFEFF','\u0085','\u200B','\ud800','\u2003Réviser.\uFEFF']) {
        const agent=mode===null?'{}':JSON.stringify({planFirst:mode});
        ctrl('plan',agent,[{kind:'allows',effect:'read'},{kind:'allows',effect:'unknown'},step({kind:'turnEnded',turnId:'before'},'before'),step({kind:'planPresented',planId:'p',text:'Plan'},'p'),step({kind:'planResolved',planId:'p',decision:'reject',comment},'decision'),step({kind:'planPresented',planId:'p2',text:'New plan'},'p2'),step({kind:'planResolved',planId:'p2',decision:'accept'},'accept'),submit('{}'),physical()]);
    }
    for (const stdout of ['', 'ééé', '😀a', '\ud800x', '\udc00', '\ud800\udc00', '\n\u0000']) for(const stderr of ['error','é😀','\udc00']) for(const bound of [0,1,2,3,4,5,6,9007199254740991]) {
        ctrl('check','{"completionCheck":{"command":"test","maxFailures":1}}',[submit('{}'),check(1,{stdout,stderr}),{kind:'snapshot'},physical()],{options:{...options,maxCheckOutputBytes:bound}});
    }
    for(const exitCode of [null,0,-0,1,-1,9007199254740991,-9007199254740991,9007199254740992,-9007199254740992,0.5,1e100,'0',false]) for(const physicalState of ['ended','uncertain']) {
        ctrl('check','{"completionCheck":{"command":"test"}}',[submit('{}','call'),submit('{"unknown":1}','invalid'),submit('{}','competing'),check(exitCode,{physicalState}),submit('{}','competing'),submit('{}','new'),physical()]);
    }
    for (const maxFailures of [0,1,2,3]) for(const budget of [0,1,2]) {
        const agent=JSON.stringify({maxCorrections:budget,completionCheck:{command:'test',maxFailures}});
        ctrl('check',agent,[submit('{}','call'),check(1),submit('{}','new'),step({kind:'checkEnded',checkId:'work:check:3',physicalState:'ended',exitCode:1,stdout:'e',stderr:''},'check2'),physical()]);
    }
    for (const checkTimeoutMs of ['1','1e2',' 1000 ','-0','0','-1','1.5','1e999999999999999999999','\ud800',null,1]) for(const maxCheckOutputBytes of [0,-0,1,-1,0.5,9007199254740991,9007199254740992,null,'5']) ctrl('options','{}',[submit('{}')],{options:{checkTimeoutMs,maxCheckOutputBytes,enforcedPlanLock:true}});
    for (const enforcedPlanLock of [true,false,null,1,'true']) ctrl('options','{"planFirst":"ask"}',[],{options:{...options,enforcedPlanLock}});
    for (const extra of [0,1,-0,1e100,'𝄞','\ud800',{ '10':1,'2':2,z:3 },[1,true]]) {
        const event={kind:'visibleText',messageId:'m',textParts:['text'],extra};
        ctrl('controller','{}',[step(event,'m'),step(event,'m2'),step({...event,extra:'different'},'m'),submit('{}'),physical()]);
    }
    for(const messages of [[[],[''],['a','b'],[''],['c']],[['\ud800','\udc00'],['é','😀']],[['\ud800'],['\udc00']],[['\u0000','\n','\u2028']],[]]) for(let i=0;i<5;i++) add('visible','visible',{messages});
    const syntax = ['', '{', '[', '[1', '[1,', '{1:2}', "{'x':1}", 'NaN','undefined','Infinity','+1','-','-.1','1.','1e','1e+','01','[01]','truex','tru','{} false','[1 2]','{"x"}','{"x":}','{"x":1,}','[1,]','[1,,2]','"','"a\n"','"\\q"','"\\u"','"\\u123"','"\\u12xz"','\ud800','"\ud800"','{"\udc00":1}','\ufeff{}',']','}',':',',','[}','{]','{"a":tru}','[falsez]'];
    for(const raw of syntax) for(const prefix of ['', '[', '{"x":']) add('nativeSyntax','parse',{raw:prefix+raw});
    for (const token of ['1e','1e+','1e-','1eX','1e+X','1e-0','00','1.','1.x','1..1','-','-x','-01','truex','falsex','nullx','trux','fals','nul','x','foo','é','😀','a_2','$foo','\\x']) {
        for (const [prefix,suffix] of [['',''],['[',']'],['{"x":','}'],['{',':0}'],['{} ',''],['[1 ',']']]) add('nativeSyntax','parse',{raw:prefix+token+suffix});
    }
    for(const raw of ['"\\ud800"','"\ud800"','"\udc00"','"😀"','{"x":1,"x":2}','{"2":0,"1":1,"z":2}','1e400','-1e-400','9007199254740993']) add('nativeSyntax','parse',{raw});
    for (let i=0;i<6;i++) ctrl('mutations','{}',[
        {...submit('{}','one'),mutateReceipt:[{revision:'999',decision:{kind:'stopping',code:'REVOKED'}},{revision:'999'},{receiptId:'foreign'},{owner:{...owner,ownerEpoch:'foreign'}},{decision:{kind:'stopping',code:'REVOKED'}},{decision:{kind:'accepted',output:{text:'mutated',resultsJson:'{}',choice:null,instructions:null}}}][i]},
        {kind:'snapshot',mutate:{state:'finished',accepted:null}},
        submit('{}','one'),{kind:'snapshot'},physical()
    ]);
    let seed=0x30c4d15;
    const random=(n:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
    for(let i=0;i<256;i++) {
        const agent=JSON.stringify({maxCorrections:random(4),...(random(2)?{completionCheck:{command:'test',maxFailures:random(4)}}:{}),...(random(3)?{planFirst:random(2)?'auto':'ask'}:{})});
        const events:unknown[]=[];
        for(let j=0;j<24;j++) {
            const k=random(10), id=`random-${random(16)}`, operation=`op-${random(12)}`;
            const body:Input=k===0?{kind:'visibleText',messageId:operation,textParts:[['','é','😀','\ud800','text'][random(5)]]}
                :k<3?{kind:'submit',callId:operation,argumentsJson:raws[random(raws.length)]}
                :k===3?{kind:'turnEnded',turnId:operation}
                :k===4?{kind:'planPresented',planId:operation,text:['Plan','\uFEFF','\u0085'][random(3)]}
                :k===5?{kind:'planResolved',planId:operation,decision:random(2)?'accept':'reject',comment:random(2)?'Revise':''}
                :k===6?{kind:'checkEnded',checkId:`work:check:${random(24)+1}`,physicalState:random(2)?'ended':'uncertain',exitCode:random(2),stdout:'é😀',stderr:'e'}
                :k===7?{kind:'stop',reason:['TIMEOUT','STOPPED','JOIN_CANCELLED','INTERRUPTED'][random(4)]}
                :{kind:'physicalEnded',providerEnded:!!random(2),effectsEnded:!!random(2)};
            events.push(step(body,id));if(j%5===0) events.push({kind:'snapshot'},{kind:'allows',effect:['read','change','unknown'][random(3)]});
        }
        ctrl('generated',agent,events);
    }
    for(const value of [undefined,null,1,true,[],{}]) {
        for(const kind of ['planPresented','planResolved','submit','visibleText']) {
            const event=kind==='planPresented'?{kind,planId:'p',text:value}:kind==='planResolved'?{kind,planId:'p',decision:'reject',comment:value}:kind==='submit'?{kind,callId:'c',argumentsJson:value}:{kind,messageId:'m',textParts:value};
            const events=kind==='planResolved'?[step({kind:'planPresented',planId:'p',text:'Plan'},'p'),step(event,'e')]:[step(event,'e')];
            ctrl('malformed-event',kind.startsWith('plan')?'{"planFirst":"ask"}':'{}',events);
        }
        for(const input of [{owner:value,eventId:'e',event:{kind:'turnEnded',turnId:'t'}},{owner,eventId:'e',event:value},value]) ctrl('malformed-event','{}',[{input}]);
    }
    for(const number of ['-0','0.999999999999999999999','1e-400','1e400','-1e400','9007199254740991.1','9007199254740990.5','9007199254740992','-9007199254740991']) {
        const base={owner,options,agent:'{}',steps:[submit('{}')]};
        const json=JSON.stringify({...base,options:{...options,maxCheckOutputBytes:'RAW_NUMBER'}}).replace('"RAW_NUMBER"',number);
        cases.push({family:'options',request:{op:'controller',json}});
        const submission=JSON.stringify({...base,steps:[submit('RAW_NUMBER')]}).replace('"RAW_NUMBER"',number);
        cases.push({family:'submission',request:{op:'controller',json:submission}});
    }
    for(const stdout of [undefined,null,1,true,false,[],{},['é',null,1],['\ud800']]) for(const maxCheckOutputBytes of [0,5,20]) {
        ctrl('malformed-event','{"completionCheck":{"command":"test"}}',[submit('{}'),check(1,{stdout})],{options:{...options,maxCheckOutputBytes}});
    }
    ctrl('controller','{}',[step({kind:'submit',callId:'c',argumentsJson:'{}'},'same'),step({callId:'c',kind:'submit',argumentsJson:'{}'},'other')]);
    const contractJson=JSON.stringify(createAgentWorkContract030({agentJson:'{"results":{"x":{"required":true}}}' as ExactJsonText}));
    const event=(id:string,body:Input)=>JSON.stringify({owner,eventId:id,event:body});
    const host=(id:string,stateJson:string,expectedRevision:string,eventJson:string)=>({context,eventId:id,expectedRevision,contractJson,stateJson,eventJson,optionsJson:JSON.stringify(options)});
    let state=EMPTY_WORK_JOURNAL030;
    for(let i=0;i<8;i++) {
        const id=`j-${i}`;const eventJson=event(id,i===7?{kind:'submit',callId:'valid',argumentsJson:'{"results":{"x":9007199254740993}}'}:{kind:'visibleText',messageId:id,textParts:[`text-${i}`]});
        const input=host(id,state,String(i),eventJson);add('journal','host',input);
        const valid=evaluateHostWork030(context,id,String(i),contractJson,state,eventJson,JSON.stringify(options),validator);
        const journal=JSON.parse(valid.stateJson);
        add('journal','host',host('next',valid.stateJson,String(i+1),event('next',{kind:'physicalEnded',providerEnded:true,effectsEnded:true})));
        for(const mutation of ['receipt','receiptWhitespace','event','extra','shape']) {
            const altered=JSON.parse(valid.stateJson);
            if(mutation==='receipt') altered.events[0].receiptJson='{}';
            if(mutation==='receiptWhitespace') altered.events[0].receiptJson=altered.events[0].receiptJson.replace(':', ' : ');
            if(mutation==='event') altered.events[0].eventJson='{';
            if(mutation==='extra') altered.events[0].extra=true;
            if(mutation==='shape') altered.events[0]=null;
            add('journal','host',host('next',JSON.stringify(altered),String(journal.events.length),event('next',{kind:'turnEnded',turnId:'next'})));
        }
        state=valid.stateJson;
    }
    for(const expectedRevision of ['0','00','01','-1','1','0\n','0\r','0\r\n','0\u2028','9007199254740993']) add('journal','host',host('first',EMPTY_WORK_JOURNAL030,expectedRevision,event('first',{kind:'visibleText',messageId:'m',textParts:['']})));
    for(const stateJson of ['{}','null','[]','{"format":"macro-agsdl-work-journal/1","events":[],"extra":1}','{','{"format":"macro-agsdl-work-journal/1","events":[{}]}']) add('journal','host',host('first',stateJson,'0',event('first',{kind:'turnEnded',turnId:'t'})));
    for(let i=0;i<12;i++) {
        const input=host('first',EMPTY_WORK_JOURNAL030,'0',event(i%2?'other':'first',{kind:'turnEnded',turnId:'t'}));
        if(i%3===0) input.context={...context,work:{...context.work,agentInstanceId:''}};
        if(i%3===1) input.eventJson=JSON.stringify({owner:{...owner,ownerEpoch:'foreign'},eventId:'first',event:{kind:'turnEnded',turnId:'t'}});
        if(i%3===2) input.eventJson=i%2?'null':'[]';
        add('attribution','host',input);
    }
    // A dot is a syntax token: its diagnostic belongs to the parser context.
    // Incomplete decimals and unrelated lexical errors retain their own errors.
    for (const token of ['1.1.','1e1.','1e+1.','-1.1.','0.1.','1.1.0','1e1.0','1.1 .','1e1 .']) {
        for (const [prefix,suffix] of [['',''],['[',']'],['{"k":','}']]) add('syntaxDot','parse',{raw:prefix+token+suffix});
    }
    for (const raw of ['.','[.]','{"k":.}','{.}','{"k".}','[,.]','[1,.]','.x','.1','true.','[true.]','"x".','["x".]','[].','[[] .]','{}.','[{}.]','true .','[true .]','1.1@','[1.1@]','{"k":1.1@}','1.1 @','[1.1 @]','{"k":1.1 @}']) add('syntaxDot','parse',{raw});
    const nextEvent=event('next',{kind:'turnEnded',turnId:'next'});
    const dotHost=host('next',EMPTY_WORK_JOURNAL030,'0',nextEvent);
    for (const raw of ['1.1.','[1.1.]','{"k":1.1.}','1e1.','1e+1.']) {
        const altered={format:'macro-agsdl-work-journal/1',events:[{eventJson:raw,receiptJson:'{}'}]};
        add('syntaxDotJournal','host',{...dotHost,expectedRevision:'1',stateJson:JSON.stringify(altered)});
    }
    for (const field of ['eventJson','contractJson','optionsJson','stateJson']) add('syntaxDotJournal','host',{...dotHost,[field]:'[1.1.]'});
    // Remove only byte-identical deterministic requests. This never changes
    // a retained input or any of the independent raw conformance captures.
    const seen = new Set<string>();
    return cases.filter(({ request }) => {
        const key = request.op + '\0' + request.json;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
