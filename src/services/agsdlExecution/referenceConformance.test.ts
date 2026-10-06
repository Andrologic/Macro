/** Optional differential checks against the unmodified published Python helpers.
 * Set AGSDL_REFERENCE_DIR to a local checkout of AgSDL v0.2.0. No network is used.
 */
import { describe, expect, it } from 'bun:test';
import { agentContent, deliveryMessage, prepareMessage } from './content';
import { evaluatePredicate, validateCompletion } from './constraints';
import { clone, decode, encode, equal, record } from './exact';
import { documentFixture, id, registryFixture } from './conformanceFixtures';
import { compilePlan, sourceDigest } from './compiler';
import type { FlowValue } from './contracts';

const referenceDir = process.env.AGSDL_REFERENCE_DIR;
const PYTHON = String.raw`
import sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'tooling'/'0.2'))
from reader import loads,dumps,equal,validate
from check_delivery import delivered_message,validate_origin_record,check_delivery,operand_value
from check_completion import check_completion
from sources import prepare_message,agent_content
payload=loads(sys.stdin.buffer.read())
document=payload['document']
assert validate(document)['valid'], 'Differential fixture document must be valid'
def predicate(test,current):
    if 'equals' in test:
        operands=[operand_value(o,current) for o in test['equals']]
        return equal(*operands)
    if 'all' in test:
        outcomes=[predicate(p,current) for p in test['all']]
        return all(outcomes)
    return not predicate(test['not'],current)
outputs={'delivery':[],'prepare':[],'completion':[],'condition':[]}
for case in payload['delivery']:
    try:
        validate_origin_record(document,case['origin'],case['input'])
        message=delivered_message(document,case['origin'],case['input'])
        report=check_delivery(document,'worker',dict(case,message=message,configuration='fixed'))
        outputs['delivery'].append({'valid':report['valid'],'message':message})
    except (ValueError,KeyError,IndexError): outputs['delivery'].append({'valid':False})
for case in payload['prepare']:
    try: outputs['prepare'].append({'valid':True,'message':prepare_message(document,case['step'],case['input'])[0]})
    except (ValueError,KeyError,IndexError): outputs['prepare'].append({'valid':False})
for case in payload['completion']:
    report=check_completion(document,'work',case)
    outputs['completion'].append({'valid':report['valid'],**({'text':report['text'],'results':report['normalizedResults']} if report['valid'] else {'code':report['error']['code']})})
for case in payload['condition']:
    try: outputs['condition'].append({'valid':True,'value':predicate(case['test'],case['input'])})
    except (ValueError,KeyError,IndexError): outputs['condition'].append({'valid':False})
outputs['initialization']=agent_content(document,'worker')[0]
print(dumps(outputs))
`;

describe.skipIf(!referenceDir)('published Python differential conformance', () => {
  it('agrees on delivery, prepare, initialization, completion and predicates using official exact operands', () => {
    const document = documentFixture();
    document.skills = { reusable: { prompt: [{ value: 'First instruction' }], resources: { initial: { value: 'Information' } } } };
    const agent = record(record(document.agents).worker);
    agent.skills = ['reusable'];
    agent.interface = decode('{"outputMediaTypes":["text/plain","application/json"],"results":{"report":{"required":true,"mediaTypes":["application/json"],"valueSchema":{"type":"integer","enum":[9007199254740993]}}}}');
    record(document.bindings).decision = decode('{"contract":{"identity":"synthetic/decision","version":"1"},"implementation":{"identity":"synthetic/publication","version":"1"}}');
    const step = record(record(record(document.flow).steps).work);
    step.decision = { binding: 'decision', choices: ['done'] }; step.next = { done: [] };
    const delivery = decode('[{"origin":"entry","input":{"prompt":[{"value":"Instruction"}],"resources":{"n":{"value":9007199254740993}}}},{"origin":"prepare","input":{}},{"origin":"agent","input":{"responseMessages":[["A","B"],[],["\\nC"],["D\\n"]]}},{"origin":"call","input":{"data":{"prompt":[{"value":"literal"}],"n":9007199254740993}}},{"origin":"error","input":{"error":{"code":"CALL_FAILED","message":"retry","details":[]}}},{"origin":"agent","input":{"text":"contradiction","responseMessages":[["actual"]]}}]') as Array<ReturnType<typeof record>>;
    const prepare = decode('[{"step":{"type":"prepare","message":{"prompt":[{"value":"Task"}],"resources":{"r":{"select":{"path":["data"]}}}}},"input":{"data":{"n":9007199254740993,"uri":"literal"}}},{"step":{"type":"prepare","message":{"resources":{"r":{"source":{"path":["results","r"]}}}}},"input":{"results":{"r":{"value":[9007199254740993,true],"mediaType":"application/json"}}}},{"step":{"type":"prepare","message":{"resources":{"r":{"source":{"value":{"ref":"missing"}}}}}},"input":{}},{"step":{"type":"prepare","message":{"resources":{"r":{"select":{"path":["missing"]}}}}},"input":{}}]') as Array<ReturnType<typeof record>>;
    const completion = decode('[{"results":{"report":{"value":9007199254740993.0,"mediaType":"application/json"}},"choice":"done","responseMessages":[["A","B"],[],["\\nC"],["D\\n"]]},{"text":"done","choice":"done"},{"results":{"report":{"value":9007199254740992,"mediaType":"application/json"}},"choice":"done"},{"results":{"report":{"value":true,"mediaType":"application/json"}},"choice":"done"},{"results":{"report":{"value":9007199254740993,"mediaType":"application/json"}}},{"text":"wrong","responseMessages":[["actual"]]}]') as Array<ReturnType<typeof record>>;
    const condition = decode('[{"test":{"equals":[{"path":["data","n"]},{"value":9007199254740993.0}]},"input":{"data":{"n":9007199254740993}}},{"test":{"equals":[{"value":true},{"value":1}]},"input":{}},{"test":{"equals":[{"value":{"a":1,"b":2}},{"value":{"b":2,"a":1.0}}]},"input":{}},{"test":{"all":[{"equals":[{"value":0},{"value":1}]},{"not":{"equals":[{"path":["missing"]},{"value":0}]}}]},"input":{}}]') as Array<ReturnType<typeof record>>;
    const child = Bun.spawnSync(['python3', '-c', PYTHON, referenceDir!], { stdin: new TextEncoder().encode(encode({ document, delivery, prepare, completion, condition })), env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(child.exitCode).toBe(0);
    if (child.exitCode) throw new Error(new TextDecoder().decode(child.stderr));
    const reference = record(decode(new TextDecoder().decode(child.stdout)));
    const deliveryResults = reference.delivery as ReturnType<typeof record>[];
    delivery.forEach((value, index) => {
      if (deliveryResults[index].valid === false) expect(() => deliveryMessage(document, { origin: value.origin as FlowValue['origin'], valueJson: encode(value.input) })).toThrow();
      else expect(equal(decode(deliveryMessage(document, { origin: value.origin as FlowValue['origin'], valueJson: encode(value.input) })), deliveryResults[index].message)).toBe(true);
    });
    const preparationResults = reference.prepare as ReturnType<typeof record>[];
    prepare.forEach((value, index) => {
      if (preparationResults[index].valid === false) expect(() => prepareMessage(document, record(value.step), value.input)).toThrow();
      else expect(equal(prepareMessage(document, record(value.step), value.input), preparationResults[index].message)).toBe(true);
    });
    const completionResults = reference.completion as ReturnType<typeof record>[];
    completion.forEach((value, index) => {
      if (completionResults[index].valid === false) expect(() => validateCompletion(record(agent.interface), step, value)).toThrow();
      else {
        const actual = validateCompletion(record(agent.interface), step, value);
        expect(actual.text).toBe(completionResults[index].text);
        expect(equal(actual.results, completionResults[index].results)).toBe(true);
      }
    });
    const conditionResults = reference.condition as ReturnType<typeof record>[];
    condition.forEach((value, index) => {
      if (conditionResults[index].valid === false) expect(() => evaluatePredicate(value.test, value.input)).toThrow();
      else expect(evaluatePredicate(value.test, value.input)).toBe(conditionResults[index].value as boolean);
    });
    expect(equal(agentContent(document, 'worker'), clone(reference.initialization))).toBe(true);
  });
  it('refuses the published steering, approval, composition and parallel examples before any binding path', async () => {
    for (const name of ['steering', 'protected-publication', 'reusable-checker', 'parallel-reviews']) {
      const authoredSource = await Bun.file(`${referenceDir}/tooling/0.2/examples/${name}.json`).text();
      const source = { owner: { projectId: 'synthetic', planId: 'synthetic', branch: 'feature/synthetic' }, revision: '1', sourceSha256: id<'sha256'>(await sourceDigest(authoredSource)) };
      const result = await compilePlan(authoredSource, source, registryFixture(documentFixture()));
      expect(result.static.valid).toBe(true);
      expect(result.runtime.supported).toBe(false);
      expect(result.plan).toBeNull();
      expect(result.runtime.diagnostics[0].code).toBe('UNSUPPORTED');
    }
  });

});
