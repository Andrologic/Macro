/** Prepare only the route selected by the native reducer from a captured 0.3 plan. */
import type { ExactJsonText, StepAddress } from './contracts';
import type { CompiledTarget030 } from './contracts030';
import { ConformanceError, clone, decode, encode, equal, fail, list, record, text } from './exact';
import { instructionAuthority030, resolveRouteMessage030, type CapturedContent030 } from './messages030';
import { instructionsExpectation030, normalizeRoute030, preflightExpansion030, type ItemContext030, type PromptProvenance030, type RouteSource030, type Scope030 } from './routes030';

export interface NativeRouteRef030 { readonly source: StepAddress; readonly kind: 'normal' | 'error'; readonly key: string | null }
export interface NativeProducer030 {
  readonly activationId: string; readonly step: StepAddress | null; readonly kind: string;
  readonly inputJson: ExactJsonText; readonly messageJson: ExactJsonText | null;
  readonly itemJson: ExactJsonText | null; readonly outputJson: ExactJsonText;
}
export interface DeliveryOccurrence030 { readonly nativeReceiptId: string; readonly targetOrdinal: number; readonly itemIndex: string }
export interface PreparedItem030 { readonly messageJson: ExactJsonText | null; readonly itemJson: ExactJsonText | null; readonly occurrence: DeliveryOccurrence030 }
export interface PreparedBatch030 { readonly targetOrdinal: number; readonly target: CompiledTarget030; readonly items: readonly PreparedItem030[] }
export interface OccurrenceProvenance030 { readonly occurrence: DeliveryOccurrence030; readonly prompt: PromptProvenance030; readonly source: RouteSource030; readonly producer: NativeProducer030 }
export interface PrepareFlowRouteInput030 {
  readonly planJson: ExactJsonText; readonly reference: { readonly route: NativeRouteRef030 };
  readonly producer: NativeProducer030; readonly source: RouteSource030; readonly nativeReceiptId: string;
  readonly content?: CapturedContent030;
}
export type PrepareFlowRouteResult030 =
  | { readonly kind: 'ready'; readonly batches: readonly PreparedBatch030[]; readonly provenance: readonly OccurrenceProvenance030[] }
  | { readonly kind: 'failed'; readonly targetOrdinal: number; readonly error: { readonly code: string; readonly message: string; readonly details: readonly { readonly path: string }[] } };

/** The native host authenticates every input and revalidates the prepared receipt at commit. */
export function prepareFlowRoute030(input: PrepareFlowRouteInput030): PrepareFlowRouteResult030 {
  try { return prepareCapturedRoute030(input); }
  catch (error) {
    if (error instanceof ConformanceError && ['PARSE', 'INVALID_RECORD', 'REFERENCE', 'DUPLICATE', 'ROUTES', 'MESSAGE_PATH'].includes(error.code)) return fail('CORRELATION', error.pointer, error.message);
    throw error;
  }
}

function prepareCapturedRoute030(input: PrepareFlowRouteInput030): PrepareFlowRouteResult030 {
  const { reference, producer, source, nativeReceiptId } = input;
  if (!nativeReceiptId || !producer.activationId || source.terminalId !== producer.activationId || source.outputJson !== producer.outputJson || !equal(source.producerStep, producer.step)) return fail('CORRELATION', '', 'Producer and attested source disagree.');
  const plan = record(decode(input.planJson));
  if (plan.format !== 'macro-agsdl-compiled-plan/2') return fail('CORRELATION', '', 'Expected a captured 0.3 plan.');
  const steps = list(plan.steps).map(value => record(value));
  const sourceStep = steps.find(step => equal(step.address, reference.route.source));
  const producerStep = steps.find(step => equal(step.address, producer.step));
  if (!sourceStep || !producerStep || producer.kind !== producerStep.type || !producer.step) return fail('CORRELATION', '', 'The captured producer is not a declared step.');
  const direct = equal(reference.route.source, producer.step);
  const compose = sourceStep.type === 'compose' && producer.step.length > reference.route.source.length
    && reference.route.source.every((part, index) => producer.step![index] === part);
  if (!direct && !compose) return fail('CORRELATION', '', 'The producer is outside the selected route.');
  if (reference.route.kind === 'error' ? source.kind !== 'error' : source.kind !== producer.kind) return fail('CORRELATION', '', 'Producer kind contradicts the selected route.');
  if (source.kind === 'agent' && (typeof producerStep.agent !== 'string' || source.producerAgent !== producerStep.agent)) return fail('CORRELATION', '', 'The agent does not match the captured producer.');
  if (reference.route.kind === 'normal' && producer.kind === 'approval') {
    const output = record(decode(producer.outputJson));
    if (producer.messageJson === null || !equal(output.message, decode(producer.messageJson))) return fail('CORRELATION', '', 'Approval output differs from its received message.');
  }
  const routes = list(plan.routes).map(value => record(value)).filter(route => equal(route.source, reference.route.source) && route.kind === reference.route.kind && route.key === reference.route.key);
  if (routes.length !== 1) return fail('CORRELATION', '', 'Selected route is missing or ambiguous in the captured plan.');
  if (direct && reference.route.kind === 'normal' && reference.route.key !== null) {
    const output = record(decode(producer.outputJson));
    const field = producer.kind === 'agent' || producer.kind === 'approval' ? 'choice' : producer.kind === 'call' || producer.kind === 'join' ? 'outcome' : null;
    if (field !== null && output[field] !== reference.route.key) return fail('CORRELATION', '', 'The selected route key contradicts the accepted output.');
  }
  const route = routes[0];
  const scopeAddress = list(sourceStep.scope).map(value => text(value));
  const scopes = list(plan.scopes).map(value => record(value)).filter(scope => equal(scope.address, scopeAddress));
  if (scopes.length !== 1) return fail('CORRELATION', '', 'Captured route scope is missing or ambiguous.');
  const scope: Scope030 = { prefix: scopeAddress, outputs: list(scopes[0].outputs).map(value => text(value)),
    steps: steps.filter(step => equal(step.scope, scopeAddress)).map(step => ({ address: list(step.address).map(value => text(value)) as [string, ...string[]], declarationJson: text(step.declarationJson) as ExactJsonText })) };
  const targets = normalizeRoute030(text(route.declarationJson) as ExactJsonText, scope);
  const captured = list(route.targets).map(value => record(value));
  const expected = targets.map(target => target.kind === 'output' ? { kind: 'output', scope: scopeAddress, name: target.name } : {
    kind: 'step', address: target.address, messageJson: target.messageJson ?? null, eachPathJson: target.eachPathJson ?? null,
    concurrencyJson: target.concurrencyJson ?? null, maxJson: target.maxJson ?? null,
  });
  if (!equal(captured, expected) || targets.some(target => target.kind === 'output')) return fail('CORRELATION', '', 'Captured targets contradict the selected route or contain an unresolved output.');
  const documentJson = text(plan.documentJson) as ExactJsonText;
  const document = record(decode(documentJson));
  if (source.kind === 'agent') {
    const agents = record(document.agents);
    const agentJson = encode(agents[source.producerAgent!]);
    for (const [index, target] of targets.entries()) {
      if (target.kind === 'step' && instructionsExpectation030(agentJson, target.declarationJson, scope) !== 'none'
        && !instructionAuthority030(source, encode(['instructions']))) {
        return fail('CORRELATION', `/targets/${index}`, 'The selected mission has no attested instruction provenance.');
      }
    }
  }
  const expansion = preflightExpansion030(targets, source);
  if (expansion.kind === 'failed') {
    const error = record(record(decode(expansion.errorJson)).error);
    return { kind: 'failed', targetOrdinal: expansion.targetIndex, error: { code: text(error.code), message: text(error.message), details: [] } };
  }
  const batches: PreparedBatch030[] = [], provenance: OccurrenceProvenance030[] = [];
  for (const [targetOrdinal, batch] of expansion.batches.entries()) {
    if (batch.target.kind !== 'step') return fail('CORRELATION', '', 'Reducer must resolve composition outputs before preparation.');
    const target = batch.target;
    const values = batch.kind === 'fanout' ? list(decode(batch.listJson)) : [null];
    const items: PreparedItem030[] = [];
    for (const [index, value] of values.entries()) {
      const occurrence = Object.freeze({ nativeReceiptId, targetOrdinal, itemIndex: String(index) });
      const item: ItemContext030 = batch.kind === 'fanout'
        ? { kind: 'element', index: String(index), valueJson: encode(value), mission: batch.mission, instructionAuthority: batch.instructionAuthority }
        : { kind: 'absent' };
      try {
        const receivesMessage = ['agent', 'approval', 'compose'].includes(text(record(decode(target.stepJson)).type));
        const resolved = receivesMessage ? resolveRouteMessage030(documentJson, target, source, item, input.content) : null;
        items.push({ messageJson: resolved?.messageJson ?? null, itemJson: item.kind === 'element' ? item.valueJson : null, occurrence });
        provenance.push({ occurrence, prompt: clone(resolved?.promptProvenance ?? { kind: 'none' }), source: clone(source), producer: clone(producer) });
      } catch (error) {
        if (!(error instanceof ConformanceError)) throw error;
        if (['MESSAGE_PATH', 'INVALID_RECORD', 'REFERENCE', 'PARSE', 'ROUTES'].includes(error.code)) return fail('CORRELATION', error.pointer, error.message);
        return { kind: 'failed', targetOrdinal, error: { code: error.code, message: error.message, details: error.pointer ? [{ path: error.pointer }] : [] } };
      }
    }
    batches.push({ targetOrdinal, target: captured[targetOrdinal] as unknown as CompiledTarget030, items });
  }
  return { kind: 'ready', batches, provenance };
}
