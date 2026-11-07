/** Descriptive AgSDL 0.3 routes. The scheduler alone admits and starts work. */
import type { ExactJsonText, StepAddress } from './contracts';
import { ConformanceError, NumberToken, decimal, decode, encode, equal, fail, has, list, record, text, type ExactValue } from './exact';
import { instructionAuthority030, selectValue030 } from './messages030';

export interface InstructionAuthority030 {
  readonly pathJson: ExactJsonText;
  readonly producerAgent: string;
  /** Terminal of the accepted instructing producer, including inside a join. */
  readonly terminalId: string;
}
export interface ResultMetadata030 {
  readonly pathJson: ExactJsonText;
  readonly mediaType: string;
}
export type PromptProvenance030 =
  | { readonly kind: 'none' }
  | { readonly kind: 'host' }
  | { readonly kind: 'author'; readonly pointer: string }
  | { readonly kind: 'agent'; readonly authority: InstructionAuthority030 };
export interface RouteSource030 {
  readonly terminalId: string;
  readonly producerStep: StepAddress | null;
  readonly producerAgent?: string;
  readonly kind: 'entry' | 'agent' | 'call' | 'approval' | 'join' | 'error';
  readonly outputJson: ExactJsonText;
  /** Trusted captured/accepted evidence, never fields inferred from outputJson. */
  readonly provenance: {
    readonly instructions: readonly InstructionAuthority030[];
    readonly results?: readonly ResultMetadata030[];
    readonly prompt?: PromptProvenance030;
  };
}
export type ItemContext030 =
  | { readonly kind: 'absent' }
  | { readonly kind: 'element'; readonly index: string; readonly valueJson: ExactJsonText;
      readonly mission: boolean; readonly instructionAuthority?: InstructionAuthority030 };
export interface Scope030 {
  readonly prefix?: readonly string[];
  readonly steps: readonly { readonly address: StepAddress; readonly declarationJson: ExactJsonText }[];
  /** Present only for a composition body. */
  readonly outputs?: readonly string[];
  /** Selected outer continuation for each body output, including [] for a terminal route. */
  readonly outputRoutes?: Readonly<Record<string, { readonly routeJson: ExactJsonText; readonly scope: Scope030 }>>;
}
export type RouteTarget030 =
  | { readonly kind: 'step'; readonly address: StepAddress; readonly stepJson: ExactJsonText;
      readonly declarationJson: ExactJsonText; readonly messageJson?: ExactJsonText;
      readonly eachPathJson?: ExactJsonText; readonly concurrencyJson?: ExactJsonText;
      readonly maxJson?: ExactJsonText }
  | { readonly kind: 'output'; readonly name: string };
export type TargetBatch030 =
  | { readonly kind: 'fixed'; readonly target: RouteTarget030 }
  | { readonly kind: 'fanout'; readonly target: Extract<RouteTarget030, { kind: 'step' }>;
      readonly listJson: ExactJsonText; readonly length: string;
      readonly concurrencyJson?: ExactJsonText; readonly maxJson?: ExactJsonText;
      readonly mission: boolean; readonly instructionAuthority?: InstructionAuthority030 };
export type Expansion030 =
  | { readonly kind: 'ready'; readonly batches: readonly TargetBatch030[] }
  | { readonly kind: 'failed'; readonly targetIndex: number; readonly code: 'OPERAND' | 'FANOUT_LIMIT'; readonly errorJson: ExactJsonText };

function positiveInteger(value: ExactValue): void {
  if (!(value instanceof NumberToken)) return fail('ROUTES', '', 'Expected a positive integer.');
  const [sign, digits, exponent] = decimal(value);
  if (sign || digits === '0' || exponent < 0n) fail('ROUTES', '', 'Expected a positive integer.');
}
function path(value: ExactValue): void {
  for (const part of list(value)) {
    if (typeof part === 'string') continue;
    if (!(part instanceof NumberToken)) return fail('MESSAGE_PATH', '', 'Invalid selection segment.');
    const [sign, , exponent] = decimal(part);
    if (sign || exponent < 0n) fail('MESSAGE_PATH', '', 'Invalid selection index.');
  }
}
export function normalizeRoute030(routeJson: ExactJsonText, scope: Scope030): readonly RouteTarget030[] {
  const route = decode(routeJson), seen = new Set<string>();
  const targets = (Array.isArray(route) ? route : [route]).map((raw): RouteTarget030 => {
    const target = typeof raw === 'string' ? { step: raw } : record(raw);
    if (has(target, 'output')) {
      if (Object.keys(target).some(key => key !== 'output')) return fail('ROUTES', '', 'Composition output cannot carry a message or fan-out.');
      const name = text(target.output);
      if (!scope.outputs?.includes(name)) return fail('ROUTES', '', 'Output is outside this composition body.');
      const key = `output:${name}`;
      if (seen.has(key)) return fail('DUPLICATE', '', 'Repeated route target.');
      seen.add(key);
      return Object.freeze({ kind: 'output', name });
    }
    if (Object.keys(target).some(key => !['step', 'message', 'each', 'concurrency', 'max'].includes(key))) return fail('ROUTES', '', 'Invalid route target fields.');
    const name = text(target.step);
    const address: [string, ...string[]] = [name];
    address.unshift(...(scope.prefix ?? []));
    const definition = scope.steps.find(step => equal(step.address, address));
    if (!definition) return fail('REFERENCE', '', 'Unknown step in route scope.');
    const key = encode(address);
    if (seen.has(key)) return fail('DUPLICATE', '', 'Repeated route target.');
    seen.add(key);
    const step = record(decode(definition.declarationJson));
    const receivesMessage = ['agent', 'approval', 'compose'].includes(text(step.type));
    if ((has(target, 'message') || has(target, 'each')) && !receivesMessage) return fail('ROUTES', '', 'This step receives no message or item.');
    if ((has(target, 'concurrency') || has(target, 'max')) && !has(target, 'each')) return fail('ROUTES', '', 'Fan-out limits require each.');
    if (has(target, 'each')) {
      path(target.each);
      if (list(target.each)[0] === 'item') return fail('MESSAGE_PATH', '', 'each reads the source, not an item.');
    }
    for (const key of ['concurrency', 'max']) if (has(target, key)) positiveInteger(target[key]);
    return Object.freeze({ kind: 'step', address: Object.freeze(address), stepJson: definition.declarationJson,
      declarationJson: encode(raw),
      ...(has(target, 'message') ? { messageJson: encode(target.message) } : {}),
      ...(has(target, 'each') ? { eachPathJson: encode(target.each) } : {}),
      ...(has(target, 'concurrency') ? { concurrencyJson: encode(target.concurrency) } : {}),
      ...(has(target, 'max') ? { maxJson: encode(target.max) } : {}) });
  });
  return Object.freeze(targets);
}
function exceeds(count: number, maximum: ExactJsonText): boolean {
  const value = decode(maximum);
  positiveInteger(value);
  const [, digits, exponent] = decimal(value as NumberToken);
  const countDigits = String(count);
  const size = BigInt(digits.length) + exponent;
  if (size !== BigInt(countDigits.length)) return BigInt(countDigits.length) > size;
  // Only expand an exponent already bounded by the in-memory array length.
  return BigInt(count) > BigInt(digits) * 10n ** exponent;
}
export function preflightExpansion030(targets: readonly RouteTarget030[], source: RouteSource030): Expansion030 {
  const batches: TargetBatch030[] = [];
  for (const [targetIndex, target] of targets.entries()) {
    if (target.kind === 'output' || target.eachPathJson === undefined) {
      batches.push(Object.freeze({ kind: 'fixed', target }));
      continue;
    }
    try {
      const selected = selectValue030(source.outputJson, target.eachPathJson, { kind: 'absent' }, source.provenance.results);
      if (selected.kind !== 'inline') return fail('OPERAND', '', 'Fan-out requires a list, not a media file.');
      const values = decode(selected.valueJson);
      if (!Array.isArray(values)) return fail('OPERAND', '', 'Fan-out requires a list.');
      if (target.maxJson !== undefined && exceeds(values.length, target.maxJson)) return fail('FANOUT_LIMIT', '', 'Fan-out exceeds max.');
      const mission = equal(decode(target.eachPathJson), ['instructions']);
      const authority = mission ? instructionAuthority030(source, target.eachPathJson) : undefined;
      if (mission && (!authority || values.some(value => typeof value !== 'string'))) return fail('OPERAND', '', 'Fan-out missions require accepted instructing-agent instructions.');
      batches.push(Object.freeze({ kind: 'fanout', target, listJson: selected.valueJson, length: String(values.length),
        concurrencyJson: target.concurrencyJson, maxJson: target.maxJson, mission,
        ...(authority ? { instructionAuthority: authority } : {}) }));
    } catch (error) {
      if (!(error instanceof ConformanceError) || !['OPERAND', 'FANOUT_LIMIT'].includes(error.code)) throw error;
      const code = error.code as 'OPERAND' | 'FANOUT_LIMIT';
      return Object.freeze({ kind: 'failed', targetIndex, code, errorJson: encode({ error: { code, message: error.message, details: [] } }) });
    }
  }
  return Object.freeze({ kind: 'ready', batches: Object.freeze(batches) });
}
/** Resolve destination types from the captured scope before requiring a mission. */
export function instructionsExpectation030(sourceAgentJson: ExactJsonText, chosenRouteJson: ExactJsonText, scope: Scope030): 'none' | 'string' | 'list' {
  if (!scope) return fail('ROUTES', '', 'A captured route scope is required to classify destinations.');
  if (record(decode(sourceAgentJson)).instructs !== true) return 'none';
  const targets: ReturnType<typeof record>[] = [];
  const active = new Set<Scope030>();
  const collect = (routeJson: ExactJsonText, current: Scope030): void => {
    if (active.has(current)) return fail('ROUTES', '', 'Composition output continuations contain a cycle.');
    active.add(current);
    for (const target of normalizeRoute030(routeJson, current)) {
      if (target.kind === 'output') {
        if (!current.outputRoutes || !Object.hasOwn(current.outputRoutes, target.name)) return fail('ROUTES', '', 'Composition output requires its captured outer route and scope.');
        const continuation = current.outputRoutes[target.name];
        collect(continuation.routeJson, continuation.scope);
      } else if (['agent', 'approval', 'compose'].includes(text(record(decode(target.stepJson)).type))) {
        const declaration = decode(target.declarationJson);
        targets.push(typeof declaration === 'string' ? { step: declaration } : record(declaration));
      }
    }
    active.delete(current);
  };
  collect(chosenRouteJson, scope);
  let expects = false, fanout = false, single = false;
  for (const target of targets) {
    const eachInstructions = has(target, 'each') && equal(target.each, ['instructions']);
    fanout ||= eachInstructions;
    if (eachInstructions) expects = true;
    if (!has(target, 'message')) { expects = true; single ||= !eachInstructions; continue; }
    const message = record(target.message);
    if (has(message, 'prompt') && typeof message.prompt === 'object' && !Array.isArray(message.prompt) && message.prompt !== null) {
      const selected = record(message.prompt);
      if (equal(selected.from, ['instructions'])) { expects = true; single = true; }
      if (equal(selected.from, ['item']) && eachInstructions) expects = true;
    }
  }
  if (fanout && single) return fail('MESSAGE_PATH', '', 'A list of missions cannot also be one prompt.');
  return expects ? fanout ? 'list' : 'string' : 'none';
}
