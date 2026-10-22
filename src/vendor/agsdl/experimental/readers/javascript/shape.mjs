import { NumberToken, uint, pointer } from './json.mjs';
export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof NumberToken);
export const has = (v, k) => object(v) && Object.hasOwn(v, k);
const text = v => typeof v === 'string' && v.length > 0;
const identity = v => text(v) && /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const literal = (...values) => v => values.includes(v);
const array = (item, min = 0) => ({ array: item, min });
const map = item => ({ map: item });
const record = fields => ({ fields });
const optional = type => ({ optional: type });
const any = () => true;
const nullable = type => ({ union: [v => v === null, type] });
export const Key = record({ scope: text, id: text, version: text });
export const Edition = record({ identity, version: text });
export const Ref = { select: v => has(v, 'dependency') || has(v, 'key') ? record({ dependency: text, key: Key }) : Key };
export const kinds = ['Agent','Principal','Interface','Instructions','Role','Skill','ControlFlow','Action','Resource','ApprovalRequirement','Tool','Model','Environment','Runtime','Deployment','Policy','Memory','Knowledge','State','Topology','Protocol'];
export const Kind = { select: v => object(v) ? record({ extension: Edition, name: text }) : literal(...kinds) };
export const Dependency = record({ id: text, rootKey: Key, status: literal('included','external','omitted','unavailable'), requiredFor: array(literal('validateD','resolveG','exchange')), sha256: nullable(hash), location: optional(text) });
export const Relation = record({ source: Key, relation: literal('actsAs','exposes','directedBy','uses','contains'), target: Ref, expectedKind: Kind });
export const Definition = record({ key: Key, kind: Kind, owner: Key, payload: any, annotations: optional(any), provenance: optional(any) });
export const Deferral = record({ subject: Key, obligation: literal('agent-interface-minimum'), rule: literal('fragment-interface-deferral'), relation: literal('exposes'), expectedKind: literal('Interface'), missingMinimum: v => uint(v, true) && Number(v.raw) === 1, target: nullable(Key), satisfyBy: literal('typed-exposes-relation'), expiresBefore: literal('resolved-graph') });
const mode = { select: v => object(v) ? record({ ignoreRule: literal('annotation-only') }) : literal('required','unknown') };
export const Extension = record({ identity, version: text, operations: record({ validateD: optional(mode), validateG: optional(mode), validateR: optional(mode) }), payload: any });
export const Root = record({ key: Key, kind: literal('System','Fragment','PackageVersion'), payload: optional(any), annotations: optional(any) });
export const DocumentFor = contract => record({ contract: literal(contract), root: Root, definitions: array(Definition), relations: array(Relation), exports: array(Key), dependencies: array(Dependency), unresolved: array(Deferral), extensions: array(Extension), annotations: optional(any), evidence: optional(any), graphs: optional(any), runtime: optional(any) });
export const Document = DocumentFor('proposal-0012-candidate-2');
export const Ports = map(literal('string','boolean','json'));
export const Binding = { select: v => has(v, 'input') ? record({ input: text }) : record({ step: text, port: text }) };
export const Step = { select: v => {
  switch(v?.kind) {
    case 'invoke': return record({ id:text, kind:literal('invoke'), agent:Ref, interface:Ref, action:Ref, resources:array(Ref,1), principal:Ref, context:Binding, inputs:Ports, outputs:Ports, bindings:map(Binding), success:text, failure:text });
    case 'condition': return record({ id:text, kind:literal('condition'), test:Binding, true:text, false:text, failure:text });
    case 'approval': return record({ id:text, kind:literal('approval'), requirement:Ref, timeoutMs:v=>uint(v,true), approved:text, denied:text, failure:text });
    case 'end': return v.outcome === 'success' ? record({ id:text,kind:literal('end'),outcome:literal('success'),bindings:map(Binding) }) : record({ id:text,kind:literal('end'),outcome:literal('failure','denied'),reason:text });
    default: return record({ id:text, kind:literal('invoke','condition','approval','end') });
  }
} };
export const Graph = record({ definition:Key, entry:text, inputs:Ports, outputs:Ports, steps:array(Step,1) });
export const Interface = record({ inputs:Ports, outputs:Ports, action:Ref });
export const ApprovalRequirement = record({ approvers:array(Ref,1), validForMs:v=>uint(v,true) });
export const Requirement = record({ id:text,capability:Edition,subject:Key });
export const EvidenceClaim = record({ requirement:text,claim:literal('satisfied','unsatisfied','indeterminate'),artifact:nullable(hash),location:optional(text) });
export const Selection = record({ engine:Edition,interface:Edition,model:optional(Edition),provider:optional(identity),hosting:optional(Ref),evidence:array(EvidenceClaim) });
export const Runtime = record({ requirements:array(Requirement),selection:optional(Selection) });
export const List = array;
export function errors(type, v, p = '') {
  if (typeof type === 'function') return type(v) ? [] : [p];
  if (type.select) return errors(type.select(v), v, p);
  if (type.union) { const es = type.union.map(t => errors(t,v,p)); return es.some(e=>!e.length) ? [] : es.at(-1); }
  if (type.array) {
    if (!Array.isArray(v) || v.length < type.min) return [p];
    return v.flatMap((x,i)=>errors(type.array,x,pointer(p,i)));
  }
  if (!object(v)) return [p];
  if (type.map) return Object.entries(v).flatMap(([k,x])=> k.length ? errors(type.map,x,pointer(p,k)) : [pointer(p,k)]);
  const result = [];
  for (const [k,t] of Object.entries(type.fields)) {
    if (!Object.hasOwn(v,k)) { if (!t.optional) result.push(p); }
    else result.push(...errors(t.optional || t,v[k],pointer(p,k)));
  }
  for (const k of Object.keys(v)) if (!Object.hasOwn(type.fields,k)) result.push(pointer(p,k));
  return [...new Set(result)];
}
export const valid = (t,v) => errors(t,v).length === 0;
// A shell checks parent members without making one malformed child hide siblings.
export const shell = (t,v) => object(v) && Object.keys(t.fields).every(k=>t.fields[k].optional || has(v,k)) && Object.keys(v).every(k=>Object.hasOwn(t.fields,k));
