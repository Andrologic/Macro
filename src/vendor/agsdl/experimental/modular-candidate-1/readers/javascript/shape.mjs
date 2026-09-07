import { NumberToken, uint, pointer } from './json.mjs';
import * as Base from '../../../readers/javascript/shape.mjs';

export const object = Base.object;
export const has = Base.has;
const text = v => typeof v === 'string' && v.length > 0;
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const literal = (...values) => v => values.includes(v);
const array = (item, min = 0) => ({ array: item, min });
const map = item => ({ map: item });
const record = fields => ({ fields });
const optional = type => ({ optional: type });
const nullable = type => ({ union: [v => v === null, type] });
const any = () => true;

export const Key = Base.Key;
export const Edition = Base.Edition;
export const Ref = Base.Ref;
export const Kind = Base.Kind;
export const Dependency = Base.Dependency;
export const Relation = Base.Relation;
export const Definition = Base.Definition;
export const Deferral = Base.Deferral;
export const Extension = Base.Extension;
export const Root = Base.Root;
export const Ports = Base.Ports;
export const Binding = Base.Binding;
export const List = array;

export const Document = Base.DocumentFor('proposal-0013-candidate-1');
export const Operation = record({id:text,direction:literal('inbound','outbound','bidirectional'),mode:literal('request-response'),action:Ref,inputs:Ports,outputs:Ports});
export const Interface = record({operations:array(Operation,1)});
export const ApprovalRequirement = Base.ApprovalRequirement;
export const Step = {select:v=>{
  if(v?.kind==='invoke')return record({id:text,kind:literal('invoke'),agent:Ref,interface:Ref,action:Ref,resources:array(Ref,1),principal:Ref,context:Binding,inputs:Ports,outputs:Ports,bindings:map(Binding),success:text,failure:text,operation:text});
  if(v?.kind==='approval')return record({id:text,kind:literal('approval'),requirement:Ref,timeoutMs:x=>uint(x,true),approved:text,denied:text,failure:text,call:text});
  return Base.Step.select(v);
}};
export const Graph = record({definition:Key,entry:text,inputs:Ports,outputs:Ports,steps:array(Step,1)});

export const CapabilityClaim = record({capability:Edition,status:literal('supported','unsupported','unknown'),evidence:nullable(hash)});
export const Implementation = record({id:text,implementation:Edition,parameters:any,claims:array(CapabilityClaim)});
export const ToolBinding = record({tool:Ref,choices:array(Implementation),selected:optional(text)});
export const Application = record({content:Ref,adapter:Edition,parameters:any});
export const AgentBinding = record({agent:Ref,engine:nullable(Edition),parameters:any,requires:array(Edition),claims:array(CapabilityClaim),tools:array(ToolBinding),applications:array(Application)});
export const Configuration = record({id:text,graph:Key,agents:array(AgentBinding)});
export const Runtime = record({configurations:array(Configuration),selected:optional(text)});
export const Tool = record({action:Ref,inputs:Ports,outputs:Ports,effects:literal('none','external','unknown'),failures:array(text),requires:array(Edition)});
export const Instructions = record({target:literal('Agent'),at:literal('before-invoke'),format:Edition,body:text,requires:array(Edition)});
export const Skill = record({inputs:Ports,outputs:Ports,preconditions:text,completion:text,dependencies:array(Ref),tools:array(Ref),requires:array(Edition)});

export function errors(type,v,p=''){
  if(typeof type==='function')return type(v)?[]:[p];
  if(type.select)return errors(type.select(v),v,p);
  if(type.union){const all=type.union.map(t=>errors(t,v,p));return all.some(e=>!e.length)?[]:all.at(-1);}
  if(type.array){if(!Array.isArray(v)||v.length<type.min)return[p];return v.flatMap((x,i)=>errors(type.array,x,pointer(p,i)));}
  if(!object(v))return[p];
  if(type.map)return Object.entries(v).flatMap(([k,x])=>k.length?errors(type.map,x,pointer(p,k)):[pointer(p,k)]);
  const out=[];
  for(const[k,t]of Object.entries(type.fields))if(!Object.hasOwn(v,k)){if(!t.optional)out.push(p);}else out.push(...errors(t.optional||t,v[k],pointer(p,k)));
  for(const k of Object.keys(v))if(!Object.hasOwn(type.fields,k))out.push(pointer(p,k));
  return[...new Set(out)];
}
export const valid=(t,v)=>errors(t,v).length===0;
export const shell=(t,v)=>object(v)&&Object.keys(t.fields).every(k=>t.fields[k].optional||has(v,k))&&Object.keys(v).every(k=>Object.hasOwn(t.fields,k));
