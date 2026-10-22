import type { EngineOutcome, EngineValue } from '../../types/generated/ipc';
import type { ExactJsonText, FlowValue } from './contracts';
import { conditionResult } from './constraints';
import { prepareMessage, validateOrigin } from './content';
import { ConformanceError, decode, encode, fail, has, record, text, type ExactObject } from './exact';

/** Transport origins are closed before an exact value reaches a language helper. */
export function flowInput(input: EngineValue): FlowValue {
  if (!['entry', 'prepare', 'agent', 'call', 'error'].includes(input.origin)) fail('CORRELATION', '/origin', 'Input origin is outside the captured profile.');
  return { origin: input.origin as FlowValue['origin'], valueJson: input.valueJson as ExactJsonText };
}
export function evaluatePureStep(document: ExactObject, step: ExactObject, input: EngineValue): {
  readonly outcome: EngineOutcome; readonly selectedBranch: string | null;
} {
  const current = flowInput(input);
  if (step.type === 'condition') {
    const result = conditionResult(document, encode(step.test), current);
    // Preserve the first native bytes, not a serialization of an equal object.
    return { outcome: { kind: 'completed', output: { ...input } }, selectedBranch: result.branch };
  }
  if (step.type !== 'prepare') fail('UNSUPPORTED', '/type', 'Only Prepare and Condition are pure steps.');
  return { outcome: { kind: 'completed', output: { origin: 'prepare', valueJson: encode(prepareMessage(document, step, validateOrigin(document, current))) } }, selectedBranch: null };
}
const portableCodes = new Set(['CONFIGURATION', 'INITIALIZATION', 'INPUT_CONSTRAINT', 'CONTENT_UNAVAILABLE', 'UNSUPPORTED', 'OPERAND',
  'CALL_FAILED', 'CALL_RESULT', 'OUTPUT_CONSTRAINT', 'APPROVAL', 'AGENT_FAILED', 'INTERRUPTED', 'CORRELATION', 'VISIT_LIMIT']);
/** Called only at a known no-effect or physically ended boundary. Transport
 * exceptions and pending Stop are handled by the scheduler's uncertainty path. */
export function flowFailure(error: ConformanceError, interfaceValue: ExactObject = {}, step: ExactObject = {}): EngineOutcome {
  if (error.code === 'STOP_PENDING' || error.code === 'STEERING_PENDING') throw error;
  const code = error.code === 'PERMISSION' ? 'APPROVAL' : portableCodes.has(error.code) ? error.code : 'CORRELATION';
  const details: ExactObject[] = [];
  if (code === 'OUTPUT_CONSTRAINT') {
    const name = error.pointer.split('/')[2]?.replace(/~1/g, '/').replace(/~0/g, '~');
    const definition = name && has(record(interfaceValue.results ?? {}), name) ? record(record(interfaceValue.results)[name]) : {};
    const expected = error.pointer === '/choice' ? record(step.decision ?? {}).choices ?? []
      : error.pointer.endsWith('/value') ? definition.valueSchema ?? {}
      : definition.mediaTypes ?? interfaceValue.outputMediaTypes ?? interfaceValue.results ?? {};
    details.push({ path: error.pointer, rule: 'OUTPUT_CONSTRAINT', expected });
  }
  return { kind: 'failed', code, errorJson: encode({ error: { code, message: error.message, details } }) };
}
export function retainedAgentOutcome(result: {
  readonly stopped: boolean; readonly failed: boolean;
  readonly closure: { readonly validation: import('./retainedResponses').ResponseValidation };
}, interfaceValue: ExactObject, step: ExactObject): EngineOutcome {
  if (result.stopped) return { kind: 'stopped', evidenceJson: '{"kind":"native-response-closure"}' };
  // Work precedes output validation in the normative failure order.
  if (result.failed) return flowFailure(new ConformanceError('AGENT_FAILED', '', 'Agent work ended without completion.'));
  const validation = result.closure.validation;
  if (validation.kind === 'failure') {
    const details = validation.diagnostics.flatMap(diagnostic => {
      const outcome = flowFailure(new ConformanceError('OUTPUT_CONSTRAINT', diagnostic.pointer, diagnostic.message), interfaceValue, step);
      return record(record(decode(text((outcome as Extract<EngineOutcome, { kind: 'failed' }>).errorJson))).error).details as ExactObject[];
    });
    return { kind: 'failed', code: 'OUTPUT_CONSTRAINT', errorJson: encode({ error: { code: 'OUTPUT_CONSTRAINT', message: 'Agent output violates its captured contract.', details } }) };
  }
  return { kind: 'completed', output: { origin: 'agent', valueJson: encode({ text: validation.text, results: decode(validation.resultsJson),
    ...(validation.choice === null ? {} : { choice: validation.choice }) }) } };
}
