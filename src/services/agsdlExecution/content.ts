/** Inline profile port of the official sources.py and check_delivery.py helpers.
 * Apache-2.0, AgSDL 0.2.0 ae478d6203dd1571af064317238fd0a0f7dece75.
 * See src/vendor/agsdl/NOTICE.md and LICENSE. URI transfer is deliberately refused.
 */
import { baseParts } from '../../vendor/agsdl/v0.2/declarations.mjs';
import { schema } from '../../vendor/agsdl/v0.2/values.mjs';
import type { ExactJsonText, FlowValue } from './contracts';
import { assembleVisibleText } from './invariants';
import { NumberToken, at, clone, decimal, decode, encode, fail, has, list, record, shape, text, type ExactObject, type ExactValue } from './exact';

export function operandValue(operand: ExactValue, current: ExactValue): ExactValue {
  if (!shape(operand, schema.$defs.Operand)) return fail('OPERAND', '', 'Invalid operand.');
  const definition = record(operand);
  if (has(definition, 'value')) return clone(definition.value);
  let value = current;
  for (const part of list(definition.path)) {
    if (typeof part === 'string' && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof NumberToken)) {
      if (!has(value, part)) return fail('OPERAND', '', 'Missing operand property.');
      value = value[part];
    } else if (part instanceof NumberToken && Array.isArray(value)) {
      // Normalize mathematical integer indices without rounding or expanding an unbounded exponent.
      const [sign, digits, exponent] = decimal(part);
      if (sign || exponent < 0n || exponent > BigInt(String(value.length).length)) return fail('OPERAND', '', 'Invalid array index.');
      const index = BigInt(digits) * 10n ** exponent;
      if (index >= BigInt(value.length)) return fail('OPERAND', '', 'Missing operand index.');
      value = value[Number(index)];
    } else return fail('OPERAND', '', 'Operand container does not match its path.');
  }
  return clone(value);
}
export function inlineSource(value: ExactValue, pointer = ''): ExactObject {
  if (!shape(value, schema.$defs.Source)) return fail('INVALID_RECORD', pointer, 'Invalid Source.');
  const source = record(value, pointer);
  if (has(source, 'uri')) return fail('CONTENT_UNAVAILABLE', pointer, 'URI content is outside macro-serial-inline-v1.');
  if (has(source, 'mediaType') && source.mediaType !== 'text/plain' && source.mediaType !== 'application/json') {
    return fail('CONTENT_UNAVAILABLE', at(pointer, 'mediaType'), 'Unsupported inline media type.');
  }
  if (source.mediaType === 'text/plain' && typeof source.value !== 'string') {
    return fail('CONTENT_UNAVAILABLE', at(pointer, 'value'), 'text/plain requires literal text.');
  }
  return clone(source);
}
export function normalizeMessage(document: ExactObject, value: ExactValue): ExactObject {
  if (!shape(value, schema.$defs.Message)) return fail('INVALID_RECORD', '', 'Invalid Message.');
  const input = record(value), result: ExactObject = {};
  if (has(input, 'baseUri')) {
    try { baseParts(text(input.baseUri)); }
    catch { return fail('INVALID_RECORD', '/baseUri', 'Invalid URI base.'); }
  }
  const resolve = (use: ExactValue, pointer: string): ExactObject => {
    const content = record(use);
    if (!has(content, 'ref')) return inlineSource(content, pointer);
    const name = text(content.ref), catalog = record(document.content ?? {});
    if (!has(catalog, name)) return fail('INVALID_RECORD', pointer, 'Missing content reference.');
    return inlineSource(catalog[name], at('/content', name));
  };
  if (has(input, 'prompt')) result.prompt = list(input.prompt).map((use, i) => resolve(use, `/prompt/${i}`));
  if (has(input, 'resources')) result.resources = Object.fromEntries(Object.entries(record(input.resources)).map(([key, use]) => [key, resolve(use, at('/resources', key))]));
  return result;
}
export function agentContent(document: ExactObject, agentName: string): ExactObject {
  const agent = record(record(document.agents)[agentName]);
  const message: ExactObject = { prompt: [], resources: {} };
  const selected = list(agent.skills ?? []), seen = new Set<string>();
  const containers = selected.map(name => {
    const key = text(name);
    if (seen.has(key)) return fail('DUPLICATE', '/skills', 'Repeated skill.');
    seen.add(key);
    return record(record(document.skills ?? {})[key]);
  });
  for (const container of [...containers, agent]) {
    list(message.prompt).push(...clone(list(container.prompt ?? [])));
    for (const [name, source] of Object.entries(record(container.resources ?? {}))) {
      if (has(record(message.resources), name)) return fail('RESOURCE_COLLISION', at('/resources', name), 'Skill expansion collides.');
      record(message.resources)[name] = clone(source);
    }
  }
  return normalizeMessage(document, message);
}
export function prepareMessage(document: ExactObject, step: ExactObject, current: ExactValue): ExactObject {
  if (!shape(step.message, schema.$defs.PreparedMessage)) return fail('INVALID_RECORD', '/message', 'Invalid prepared declaration.');
  const message = clone(record(step.message));
  const dynamic: ExactObject = {};
  for (const [key, value] of Object.entries(record(message.resources ?? {}))) {
    const resource = record(value);
    if (has(resource, 'select')) {
      dynamic[key] = { value: operandValue(resource.select, current) };
      if (has(resource, 'mediaType')) record(dynamic[key]).mediaType = resource.mediaType;
      dynamic[key] = inlineSource(dynamic[key], at('/resources', key));
      delete record(message.resources)[key];
    } else if (has(resource, 'source')) {
      const source = operandValue(resource.source, current);
      if (!shape(source, schema.$defs.Source)) return fail('OPERAND', at('/resources', key), 'Source selection requires a Source.');
      dynamic[key] = inlineSource(source, at('/resources', key));
      delete record(message.resources)[key];
    }
  }
  const normalized = normalizeMessage(document, message);
  if (Object.keys(dynamic).length) normalized.resources = { ...record(normalized.resources ?? {}), ...dynamic };
  return normalized;
}
export function completionText(completion: ExactObject): string {
  let visible = has(completion, 'text') ? text(completion.text) : '';
  if (has(completion, 'responseMessages')) {
    const assembled = assembleVisibleText(list(completion.responseMessages).map(message => list(message).map(part => text(part))));
    if (has(completion, 'text') && visible !== assembled) return fail('INVALID_RECORD', '/text', 'Text differs from response assembly.');
    visible = assembled;
  }
  return visible;
}
export function validateOrigin(document: ExactObject, input: FlowValue): ExactObject {
  const value = decode(input.valueJson);
  const kind = { entry: 'Message', prepare: 'Message', agent: 'Completion', call: 'CallResult', error: 'ErrorInput', join: 'JoinResult' }[input.origin];
  if (!kind || !shape(value, schema.$defs[kind])) return fail('INVALID_RECORD', '', 'Input contradicts its declared origin.');
  const current = record(value);
  if (input.origin === 'join') return fail('UNSUPPORTED', '', 'Join is outside this profile.');
  if (input.origin === 'entry' || input.origin === 'prepare') normalizeMessage(document, current);
  if (input.origin === 'agent') {
    normalizeMessage(document, { ...(has(current, 'baseUri') ? { baseUri: current.baseUri } : {}) });
    completionText(current);
    for (const [name, source] of Object.entries(record(current.results ?? {}))) inlineSource(source, at('/results', name));
  }
  return current;
}
export function deliveryMessage(document: ExactObject, input: FlowValue): ExactJsonText {
  const current = validateOrigin(document, input);
  if (input.origin === 'entry' || input.origin === 'prepare') return encode(normalizeMessage(document, current));
  if (input.origin === 'agent') {
    for (const [name, source] of Object.entries(record(current.results ?? {}))) inlineSource(source, at('/results', name));
    return encode({ resources: { result: { value: completionText(current), mediaType: 'text/plain' } } });
  }
  const error = input.origin === 'error';
  return encode({ resources: { [error ? 'error' : 'result']: { value: clone(current[error ? 'error' : 'data']), mediaType: 'application/json' } } });
}
export function validateInput(messageJson: ExactJsonText, interfaceValue: ExactObject): void {
  const message = record(decode(messageJson));
  const allowed = interfaceValue.inputMediaTypes;
  for (const source of [...list(message.prompt ?? []), ...Object.values(record(message.resources ?? {}))]) {
    const content = inlineSource(source);
    if (allowed !== undefined && !list(allowed).includes(content.mediaType)) return fail('INPUT_CONSTRAINT', '', 'Input format is not declared.');
  }
}
