// Browser adaptation: SHA-256 is supplied by the Web Crypto wrapper.
import { hash } from '../../../browser-hash.mjs';
export { hash };
import { parse, stringify, pointer } from './json.mjs';
import * as S from './shape.mjs';
export const contract = 'proposal-0012-candidate-2';
export const key = k => JSON.stringify([k.scope,k.id,k.version]);
export const pair = k => JSON.stringify([k.scope,k.id]);
export const edition = e => JSON.stringify([e.identity,e.version]);
export const equal = (a,b) => canonical(a) === canonical(b);
export function canonical(x) { return S.object(x) ? `{${Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')}}` : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : stringify(x); }
export const ext = r => S.has(r,'dependency');
export const refkey = r => key(ext(r)?r.key:r);
export const D_RULES = ['P-SYNTAX','P-SHAPE','D-IDENTITY','D-OWNER','D-REFERENCE','D-RELATION','D-CYCLE','D-EXPORT','D-AGENT','D-DEFERRAL','D-DEPENDENCY','D-INTEGRITY','X-MODE'];
const precedence = ['pass','inconclusive','unsupported','fail'];
export class Result {
  constructor(input,unit,phase,rules) { this.input=input;this.unit=unit;this.phase=phase;this.rules=new Map(rules.map(r=>[r,{ completed:false,blocked:new Set(),excluded:new Set() }]));this.findings=[];this.prerequisites=[]; }
  mark(rule,state='completed',p='') { if (!this.rules.has(rule)) this.rules.set(rule,{completed:false,blocked:new Set(),excluded:new Set()}); const r=this.rules.get(rule); if(state==='completed') r.completed=true; else r[state].add(p); }
  find(rule,p,details,outcome='fail',byte=false) { this.mark(rule); const location=byte?{byte:p}:{pointer:p}; const old=this.findings.find(f=>f.rule===rule&&equal(f.location,location)&&f.outcome===outcome); if(old) { if(!old.details.includes(details)) old.details+='; '+details; } else this.findings.push({rule,location,outcome,details}); }
  shape(type,v,p='') { const es=S.errors(type,v,p); for(const e of es)this.find('P-SHAPE',e,'Value does not satisfy the closed grammar'); this.mark('P-SHAPE');return !es.length; }
  boundary(r=false) { this.mark('X-EXECUTION','excluded','');this.mark('X-FULL-MODEL','excluded','');if(r){this.mark('X-READINESS','excluded','/runtime');this.mark('X-EVIDENCE-ASSESSMENT','excluded','/runtime');} }
  finish() {
    const checks=[];for(const [rule,r] of [...this.rules].sort(([a],[b])=>a<b?-1:a>b?1:0)) {
      if(!r.completed&&!r.blocked.size&&!r.excluded.size)r.completed=true;
      for(const state of ['blocked','completed','excluded']) if(state==='completed'?r.completed:r[state].size)checks.push({rule,state,locations:state==='completed'?[]:[...r[state]].sort().map(pointer=>({pointer}))});
    }
    const outcomes=this.findings.map(f=>f.outcome).concat(this.prerequisites.map(r=>r.verdict));if(checks.some(c=>c.state==='blocked'))outcomes.push('inconclusive');
    const verdict=precedence[Math.max(0,...outcomes.map(v=>precedence.indexOf(v)))];
    return {input:this.input,unit:this.unit,phase:this.phase,verdict,findings:this.findings,checks};
  }
}
export function context(id,bytes,annexes={}) { const parsed=parse(bytes); return {id,...parsed,annexes,defs:new Map(),deps:new Map(),selected:new Set()}; }
export function rows(ctx,name,type) { return Array.isArray(ctx.tree?.[name]) ? ctx.tree[name].map((v,i)=>({v,p:`/${name}/${i}`,ok:S.valid(type,v)})) : []; }
export function lookup(ctx,k) { const found=ctx.defs.get(key(k));return found?.length===1?found[0]:null; }
export function localIndexComplete(ctx) {
  return S.valid(S.Key,ctx.tree?.root?.key)&&Array.isArray(ctx.tree?.definitions)&&ctx.tree.definitions.every(definition=>S.object(definition)&&S.valid(S.Key,definition.key));
}
export function dependencyIndexComplete(ctx) {
  return Array.isArray(ctx.tree?.dependencies)&&ctx.tree.dependencies.every(dependency=>S.object(dependency)&&typeof dependency.id==='string'&&dependency.id.length);
}
export function build(ctx) {
  const d=ctx.tree;
  if(S.valid(S.Key,d?.root?.key))ctx.defs.set(key(d.root.key),[{v:d.root,p:'/root',root:true,ctx}]);
  for(const row of rows(ctx,'definitions',S.Definition)) if(S.valid(S.Key,row.v?.key)){const k=key(row.v.key);ctx.defs.set(k,[...(ctx.defs.get(k)||[]),{...row,ctx}]);}
  // A scope/id collision makes every version lookup ambiguous in this boundary.
  const identities=new Map();
  for(const found of ctx.defs.values())for(const x of found){const p=pair(x.v.key);identities.set(p,[...(identities.get(p)||[]),x]);}
  for(const [k,found]of ctx.defs)if(identities.get(pair(found[0].v.key)).length>1)ctx.defs.set(k,identities.get(pair(found[0].v.key)));
  for(const row of rows(ctx,'dependencies',S.Dependency))if(typeof row.v?.id==='string'&&row.v.id.length){ctx.deps.set(row.v.id,[...(ctx.deps.get(row.v.id)||[]),row]);}
}
export function declaration(ctx,ref,kind,result,rule,p) {
  if(ext(ref)) {
    const ds=ctx.deps.get(ref.dependency);
    if(ds?.length===1&&!S.valid(S.Key,ds[0].v.rootKey)){result.mark(rule,'blocked',p);return false;}
    if(!ds?.length&&!dependencyIndexComplete(ctx)){result.mark(rule,'blocked',p);return false;}
    if(!ds?.length || (ds.length===1&&ref.key.scope!==ds[0].v.rootKey.scope)) {result.find(rule,p,'External dependency or scope does not match');return false;}
    if(ds.length!==1){result.mark(rule,'blocked',p);return false;}
    return true;
  }
  const found=ctx.defs.get(key(ref));
  if(!found?.length&&!localIndexComplete(ctx)){result.mark(rule,'blocked',p);return false;}
  if(!found?.length){result.find(rule,p,'Local target does not exist');return false;}
  if(found.length!==1){result.mark(rule,'blocked',p);return false;}
  if(kind&&!S.valid(found[0].root?S.Root.fields.kind:S.Kind,found[0].v.kind)){result.mark(rule,'blocked',p);return false;}
  if(kind&&!equal(found[0].v.kind,kind)){result.find(rule,p,'Target kind does not match');return false;}
  return true;
}
export function modes(ctx,r,op) {
  const es=rows(ctx,'extensions',S.Extension),seen=new Set();
  if(!Array.isArray(ctx.tree?.extensions)){r.mark('X-MODE','blocked',S.has(ctx.tree,'extensions')?'/extensions':'');return;}
  for(const row of es){
    const e=row.v;
    if(!S.valid(S.Edition,{identity:e?.identity,version:e?.version})){r.mark('X-MODE','blocked',row.p);continue;}
    const k=edition(e),duplicate=seen.has(k);seen.add(k);
    if(duplicate){r.find('X-MODE',row.p,'Duplicate edition');continue;}
    const custom=rows(ctx,'definitions',S.Definition).some(x=>S.valid(S.Kind,x.v?.kind)&&S.object(x.v.kind)&&edition(x.v.kind.extension)===k);
    if(!S.object(e.operations)){r.mark('X-MODE','blocked',row.p);continue;}
    const m=e.operations[op],type=S.Extension.fields.operations.fields[op].optional;
    if(m!==undefined&&!S.valid(type,m)){r.mark('X-MODE','blocked',row.p);continue;}
    r.mark('X-MODE');
    if(op==='validateD'&&custom&&m!=='required')r.find('X-MODE',row.p,'Custom-kind mode conflict');
    else if(m==='required')r.find('X-MODE',row.p,'Extension interpreter not implemented','unsupported');
    else if(m===undefined||m==='unknown')r.find('X-MODE',row.p,'Extension interpretation unknown','inconclusive');
  }
}
export function validateD(ctx, expectedContract=contract) {
  const r=new Result(ctx.id,'D','unresolved-document',D_RULES);r.boundary();
  if(ctx.error){r.find('P-SYNTAX',ctx.error.byte,'Invalid UTF-8 JSON','fail',true);for(const rule of D_RULES.filter(x=>x!=='P-SYNTAX'))r.mark(rule,'blocked','');ctx.d=r.finish();return ctx.d;}
  r.mark('P-SYNTAX');r.shape(S.DocumentFor(expectedContract),ctx.tree);build(ctx);const d=ctx.tree;
  if(!S.object(d)){for(const rule of D_RULES.filter(x=>!x.startsWith('P-')))r.mark(rule,'blocked','');ctx.d=r.finish();return ctx.d;}
  const rootOK=S.valid(S.Key,d.root?.key)&&S.valid(S.Root.fields.kind,d.root?.kind), defs=rows(ctx,'definitions',S.Definition), rels=rows(ctx,'relations',S.Relation), deps=rows(ctx,'dependencies',S.Dependency), defers=rows(ctx,'unresolved',S.Deferral);
  const blockArray=(name,rules)=>{if(!Array.isArray(d[name]))for(const rule of rules){
    // Missing Agent prerequisites are reported on each affected Agent below.
    if(rule==='D-AGENT'&&name!=='definitions'&&!S.has(d,name))continue;
    r.mark(rule,'blocked',S.has(d,name)?`/${name}`:'');
  }};
  blockArray('definitions',['D-IDENTITY','D-OWNER','D-AGENT','D-REFERENCE']);blockArray('relations',['D-REFERENCE','D-RELATION','D-CYCLE','D-AGENT']);blockArray('exports',['D-EXPORT']);blockArray('unresolved',['D-DEFERRAL','D-AGENT']);blockArray('dependencies',['D-DEPENDENCY','D-INTEGRITY']);
  const seen=new Set(S.valid(S.Key,d.root?.key)?[pair(d.root.key)]:[]);
  function custom(kind,p){if(S.object(kind)){if(!Array.isArray(d.extensions)){r.mark('D-REFERENCE','blocked',p);return;}if(!rows(ctx,'extensions',S.Extension).some(x=>S.valid(S.Edition,{identity:x.v?.identity,version:x.v?.version})&&edition(x.v)===edition(kind.extension)))r.find('D-REFERENCE',p,'Custom kind edition is undeclared');}}
  for(const x of defs){
    const keyOK=S.valid(S.Key,x.v?.key),kindOK=S.valid(S.Kind,x.v?.kind),ownerOK=S.valid(S.Key,x.v?.owner);
    if(kindOK){custom(x.v.kind,x.p);r.mark('D-REFERENCE');}else r.mark('D-REFERENCE','blocked',x.p);
    if(!keyOK){r.mark('D-IDENTITY','blocked',x.p);r.mark('D-OWNER','blocked',x.p);r.mark('D-AGENT','blocked',x.p);continue;}
    r.mark('D-IDENTITY');
    if(seen.has(pair(x.v.key)))r.find('D-IDENTITY',x.p,'Duplicate local identity');
    if(!S.valid(S.Key,d.root?.key))r.mark('D-IDENTITY','blocked',x.p);
    else if(x.v.key.scope!==d.root.key.scope)r.find('D-IDENTITY',x.p,'Wrong local scope');
    if(!ownerOK||!S.valid(S.Key,d.root?.key))r.mark('D-OWNER','blocked',x.p);
    else {r.mark('D-OWNER');if(!equal(x.v.owner,d.root.key))r.find('D-OWNER',x.p,'Owner is not the root key');}
    if(!kindOK)r.mark('D-AGENT','blocked',x.p);
    seen.add(pair(x.v.key));
  }
  const seenRel=new Set(), edges=[];
  for(const x of rels){
    const v=x.v;
    const sourceOK=S.valid(S.Key,v?.source),targetOK=S.valid(S.Ref,v?.target),kindOK=S.valid(S.Kind,v?.expectedKind),relationOK=['actsAs','exposes','directedBy','uses','contains'].includes(v?.relation);
    if(kindOK){r.mark('D-REFERENCE');custom(v.expectedKind,x.p);}else r.mark('D-REFERENCE','blocked',x.p);
    if(sourceOK){r.mark('D-REFERENCE');declaration(ctx,v.source,null,r,'D-REFERENCE',x.p);}else r.mark('D-REFERENCE','blocked',x.p);
    if(targetOK){r.mark('D-REFERENCE');declaration(ctx,v.target,kindOK?v.expectedKind:null,r,'D-REFERENCE',x.p);}else r.mark('D-REFERENCE','blocked',x.p);
    if(sourceOK&&targetOK&&kindOK&&relationOK){
      r.mark('D-RELATION');const sig=canonical({source:v.source,relation:v.relation,target:v.target,expectedKind:v.expectedKind});
      if(seenRel.has(sig))r.find('D-RELATION',x.p,'Duplicate relation');seenRel.add(sig);
    }else r.mark('D-RELATION','blocked',x.p);
    const typed={actsAs:['Principal'],exposes:['Interface'],directedBy:['Instructions','Role','Skill','ControlFlow']};
    if(relationOK&&typed[v.relation]){
      const source=sourceOK?lookup(ctx,v.source):null;
      if(!source||!kindOK||!S.valid(source.root?S.Root.fields.kind:S.Kind,source.v.kind))r.mark('D-RELATION','blocked',x.p);
      else {r.mark('D-RELATION');if(source.v.kind!=='Agent'||!typed[v.relation].includes(v.expectedKind))r.find('D-RELATION',x.p,'Relation kind direction is invalid');}
    }
    if(v?.relation==='contains'){
      if(!sourceOK||!targetOK)r.mark('D-CYCLE','blocked',x.p);
      else if(!ext(v.target)){
        if(!lookup(ctx,v.source)||!lookup(ctx,v.target))r.mark('D-CYCLE','blocked',x.p);
        else edges.push([key(v.source),key(v.target)]);
      }
    }else if(!relationOK)r.mark('D-CYCLE','blocked',x.p);
  }
  if(edges.length){r.mark('D-CYCLE');if(cyclic(edges))r.find('D-CYCLE','/relations','Local containment cycle');}
  const exported=new Set();if(Array.isArray(d.exports)){
    if(S.valid(S.Root.fields.kind,d.root?.kind)&&((d.root.kind==='Fragment'&&!d.exports.length)||(d.root.kind==='System'&&d.exports.length)))r.find('D-EXPORT','/exports','Root export requirement');
    if(!S.valid(S.Root.fields.kind,d.root?.kind))r.mark('D-EXPORT','blocked','/exports');
    for(const [i,k]of d.exports.entries()){const p=`/exports/${i}`;if(!S.valid(S.Key,k)){r.mark('D-EXPORT','blocked',p);continue;}const found=ctx.defs.get(key(k)),duplicate=exported.has(key(k));if(found?.length>1||(!duplicate&&!found?.[0]?.root&&!localIndexComplete(ctx)))r.mark('D-EXPORT','blocked',p);else{r.mark('D-EXPORT');if(!found||found[0].root||duplicate)r.find('D-EXPORT',p,'Export is not a unique local definition');}exported.add(key(k));}
  }
  const seenDef=new Set(), validDef=new Set();
  for(const x of defers){if(!x.ok){r.mark('D-DEFERRAL','blocked',x.p);continue;}r.mark('D-DEFERRAL');const a=lookup(ctx,x.v.subject);const ar=rels.filter(y=>S.valid(S.Key,y.v?.source)&&equal(y.v.source,x.v.subject)&&S.valid(S.Relation,{source:y.v.source,relation:y.v.relation,target:y.v.target,expectedKind:y.v.expectedKind}));
    if(!rootOK||!Array.isArray(d.relations)||ctx.defs.get(key(x.v.subject))?.length>1){r.mark('D-DEFERRAL','blocked',x.p);continue;}
    const good=d.root.kind==='Fragment'&&a?.v.kind==='Agent'&&!seenDef.has(key(x.v.subject))&&ar.filter(y=>y.v.relation==='exposes').length===0&&ar.filter(y=>y.v.relation==='actsAs').length===1&&ar.some(y=>y.v.relation==='directedBy');
    if(!good)r.find('D-DEFERRAL',x.p,'Deferral preconditions not satisfied');else{validDef.add(key(x.v.subject));r.find('D-DEFERRAL',x.p,'Interface minimum deferred','deferred');}seenDef.add(key(x.v.subject));
  }
  for(const x of defs.filter(x=>S.valid(S.Key,x.v?.key)&&x.v?.kind==='Agent')){const ar=rels.filter(y=>S.valid(S.Key,y.v?.source)&&equal(y.v.source,x.v.key)&&S.valid(S.Relation,{source:y.v.source,relation:y.v.relation,target:y.v.target,expectedKind:y.v.expectedKind}));const strictMinimum=expectedContract==='agsdl-0.1.0';const minimumRelations=ar.filter(y=>!strictMinimum||(y.v.relation==='actsAs'&&y.v.expectedKind==='Principal')||(y.v.relation==='exposes'&&y.v.expectedKind==='Interface')||(y.v.relation==='directedBy'&&['Instructions','Role','Skill','ControlFlow'].includes(y.v.expectedKind)));const unique=ctx.defs.get(key(x.v.key))?.length===1;if(unique&&minimumRelations.filter(y=>y.v.relation==='actsAs').length>1){r.mark('D-AGENT');r.find('D-AGENT',x.p,'Agent relation minimum not satisfied');}if(!Array.isArray(d.relations)||rels.some(y=>(!S.valid(S.Key,y.v?.source)||equal(y.v.source,x.v.key))&&!S.valid(S.Relation,{source:y.v?.source,relation:y.v?.relation,target:y.v?.target,expectedKind:y.v?.expectedKind}))||!Array.isArray(d.unresolved)||!unique){r.mark('D-AGENT','blocked',x.p);continue;}r.mark('D-AGENT');if(minimumRelations.filter(y=>y.v.relation==='actsAs').length!==1||!minimumRelations.some(y=>y.v.relation==='directedBy')||(!minimumRelations.some(y=>y.v.relation==='exposes')&&!validDef.has(key(x.v.key))))r.find('D-AGENT',x.p,'Agent relation minimum not satisfied');}
  const ids=new Set(),roots=new Set();
  for(const x of deps){
    const dep=x.v;
    if(!S.object(dep)){r.mark('D-DEPENDENCY','blocked',x.p);r.mark('D-INTEGRITY','blocked',x.p);continue;}
    const idOK=typeof dep.id==='string'&&dep.id.length,rootKeyOK=S.valid(S.Key,dep.rootKey),statusOK=['included','external','omitted','unavailable'].includes(dep.status),reqOK=S.valid(S.Dependency.fields.requiredFor,dep.requiredFor),hashOK=S.valid(S.Dependency.fields.sha256,dep.sha256);
    const supplied=idOK&&Object.hasOwn(ctx.annexes,dep.id);
    if(idOK){r.mark('D-DEPENDENCY');if(ids.has(dep.id))r.find('D-DEPENDENCY',x.p,'Duplicate dependency id');ids.add(dep.id);}
    if(rootKeyOK){r.mark('D-DEPENDENCY');if(roots.has(key(dep.rootKey)))r.find('D-DEPENDENCY',x.p,'Duplicate dependency root key');roots.add(key(dep.rootKey));}
    if(reqOK){r.mark('D-DEPENDENCY');if(new Set(dep.requiredFor).size!==dep.requiredFor.length)r.find('D-DEPENDENCY',x.p,'Duplicate requiredFor entry');}
    if(statusOK&&idOK){r.mark('D-DEPENDENCY');if((dep.status==='included')!==supplied)r.find('D-DEPENDENCY',x.p,'Dependency delivery accounting');}
    if(!idOK||!rootKeyOK||!statusOK||!reqOK)r.mark('D-DEPENDENCY','blocked',x.p);
    if(hashOK&&idOK){r.mark('D-INTEGRITY');if(dep.sha256!==null&&supplied&&hash(ctx.annexes[dep.id])!==dep.sha256)r.find('D-INTEGRITY',x.p,'Hash mismatch');}
    if(hashOK&&reqOK){r.mark('D-INTEGRITY');if(dep.sha256===null&&dep.requiredFor.includes('validateD'))r.find('D-INTEGRITY',x.p,'Required integrity is unknown','inconclusive');}
    if(!hashOK||!idOK||!reqOK)r.mark('D-INTEGRITY','blocked',x.p);
  }
  for(const id of Object.keys(ctx.annexes))if(!ids.has(id))r.find('D-DEPENDENCY','','Undeclared annex');
  modes(ctx,r,'validateD');ctx.d=r.finish();return ctx.d;
}
export function cyclic(edges) {const adj=new Map();for(const [a,b]of edges){if(!adj.has(a))adj.set(a,[]);adj.get(a).push(b);}const active=new Set(),done=new Set();function visit(a){if(active.has(a))return true;if(done.has(a))return false;active.add(a);for(const b of adj.get(a)||[])if(visit(b))return true;active.delete(a);done.add(a);return false;}return [...adj.keys()].some(visit);}
