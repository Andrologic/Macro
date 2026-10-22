/** Inline output checking follows official check_completion.py, Apache-2.0.
 * AgSDL 0.2.0 ae478d6203dd1571af064317238fd0a0f7dece75; vendor NOTICE applies.
 */
import { schema, satisfies } from '../../vendor/agsdl/v0.2/values.mjs';
import { completionText, inlineSource, normalizeMessage, operandValue, validateOrigin } from './content';
import type { ExactJsonText, FlowValue } from './contracts';
import { resolveBinding, validateRegisteredArguments, verifyResultConstraint } from './registry';
import { clone, decode, encode, equal, fail, has, list, record, shape, text, type ExactObject, type ExactValue } from './exact';

export function evaluatePredicate(predicate: ExactValue, current: ExactValue): boolean {
  if (!shape(predicate, schema.$defs.Predicate)) return fail('OPERAND', '', 'Invalid predicate.');
  const test = record(predicate);
  if (has(test, 'equals')) {
    const operands = list(test.equals).map(operand => operandValue(operand, current));
    return equal(operands[0], operands[1]);
  }
  if (has(test, 'all')) {
    // Evaluate before reduction: every referenced operand must exist, even after false.
    const outcomes = list(test.all).map(child => evaluatePredicate(child, current));
    return outcomes.every(Boolean);
  }
  return !evaluatePredicate(test.not, current);
}
export function conditionResult(document: ExactObject, testJson: ExactJsonText, input: FlowValue): { branch: 'true' | 'false'; input: FlowValue } {
  return { branch: evaluatePredicate(decode(testJson), validateOrigin(document, input)) ? 'true' : 'false', input };
}
export function validateCompletion(interfaceValue: ExactObject, step: ExactObject, result: ExactValue): ExactObject {
  if (!shape(result, schema.$defs.Completion)) return fail('INVALID_RECORD', '', 'Invalid completion record.');
  const completion = record(result), visible = completionText(completion);
  normalizeMessage({}, { ...(has(completion, 'baseUri') ? { baseUri: completion.baseUri } : {}) });
  if (has(completion, 'choice') && !has(step, 'decision')) return fail('INVALID_RECORD', '/choice', 'This step declares no decision.');
  const allowed = interfaceValue.outputMediaTypes;
  if (visible !== '' && allowed !== undefined && !list(allowed).includes('text/plain')) return fail('OUTPUT_CONSTRAINT', '/text', 'Visible text format is not allowed.');
  const results: ExactObject = {};
  for (const [name, source] of Object.entries(record(completion.results ?? {}))) {
    const value = inlineSource(source, `/results/${name}`);
    if (allowed !== undefined && !list(allowed).includes(value.mediaType)) return fail('OUTPUT_CONSTRAINT', `/results/${name}/mediaType`, 'Output format is not allowed.');
    results[name] = value;
  }
  for (const [name, definition] of Object.entries(record(interfaceValue.results ?? {}))) {
    const rule = record(definition);
    if (!has(results, name)) {
      if (rule.required === true) return fail('OUTPUT_CONSTRAINT', `/results/${name}`, 'Required output is absent.');
      continue;
    }
    const source = record(results[name]);
    if (!list(rule.mediaTypes).includes(source.mediaType)) return fail('OUTPUT_CONSTRAINT', `/results/${name}/mediaType`, 'Named output format is not allowed.');
    if (has(rule, 'valueSchema') && !satisfies(source.value, rule.valueSchema)) return fail('OUTPUT_CONSTRAINT', `/results/${name}/value`, 'Named output does not satisfy valueSchema.');
  }
  if (has(step, 'decision') && !list(record(step.decision).choices).includes(completion.choice)) return fail('OUTPUT_CONSTRAINT', '/choice', 'Missing or undeclared choice.');
  const normalized: ExactObject = { text: visible, results };
  if (has(completion, 'choice')) normalized.choice = completion.choice;
  return normalized;
}
export function callArguments(document: ExactObject, step: ExactObject, input: FlowValue): ExactJsonText {
  const current = validateOrigin(document, input);
  return encode(Object.fromEntries(Object.entries(record(step.arguments ?? {})).map(([name, operand]) => [name, operandValue(operand, current)])));
}
export function callResult(data: ExactValue, resultSchema: ExactJsonText): FlowValue {
  verifyResultConstraint(resultSchema);
  if (!satisfies(data, decode(resultSchema))) return fail('CALL_RESULT', '/data', 'Call data violates its registered result constraint.');
  return { origin: 'call', valueJson: encode({ data: clone(data) }) };
}
export function completionResult(interfaceValue: ExactObject, step: ExactObject, result: ExactValue): FlowValue {
  return { origin: 'agent', valueJson: encode(validateCompletion(interfaceValue, step, result)) };
}
export function selectedRoute(interfaceValue: ExactObject, step: ExactObject, result: ExactValue): readonly string[] {
  const completed = validateCompletion(interfaceValue, step, result);
  if (has(step, 'decision')) {
    const choice = text(completed.choice, '/choice');
    if (!list(record(step.decision).choices).includes(choice)) return fail('OUTPUT_CONSTRAINT', '/choice', 'Undeclared choice.');
    return list(record(step.next)[choice]).map(value => text(value));
  }
  return list(step.next ?? []).map(value => text(value));
}
/** The future host uses this boundary before registering any Call/Tool effect. */
export function prepareCall(document: ExactObject, step: ExactObject, input: FlowValue, registry: import('./registry').CapturedRegistry): {
  readonly bindingJson: ExactJsonText;
  readonly argumentsJson: ExactJsonText;
  readonly scopeJson: ExactJsonText | null;
} {
  if (step.type !== 'call') return fail('INVALID_REQUEST', '', 'Select a Call step.');
  const bindingName = text(step.binding);
  const binding = resolveBinding(document, bindingName, registry, 'call');
  const current = validateOrigin(document, input);
  const argumentsJson = callArguments(document, step, input);
  validateRegisteredArguments(binding, argumentsJson);
  const scope = has(step, 'scope') ? record(step.scope) : null;
  const scopeJson = scope === null ? null : encode({ action: clone(scope.action), resources: clone(scope.resources), context: operandValue(scope.context, current) });
  return { bindingJson: encode(record(document.bindings)[bindingName]), argumentsJson, scopeJson };
}
