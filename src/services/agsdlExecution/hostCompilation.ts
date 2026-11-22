import schema030 from '../../vendor/agsdl/v0.4/schema/agsdl.schema.json';
import { SchemaChecker } from '../../vendor/agsdl/v0.4/schemacheck.mjs';
import { compilePlan030 } from './compiler030';
import { compileStaticGraph030 } from './compilerGraph030';
import type { ExactJsonText,SourceRevision } from './contracts';
import type { CapturedRegistry030,CompilationResult030 } from './contracts030';
import { ConformanceError,decode,has,record,type ExactObject } from './exact';
import { resolveRouteMessage030 } from './messages030';

// Keep in sync with CompileBroker's native transport bound, measured in UTF-8 bytes.
export const HOST_COMPILE_RESULT_LIMIT = 8_000_000;
interface Validations {
  readonly entryValidation?: { readonly messageJson: unknown; readonly valid: boolean; readonly shapeValid?: boolean; readonly unassessed?: readonly string[] };
  readonly deliveryValidation?: { readonly input: unknown; readonly valid: boolean; readonly shapeValid?: boolean; readonly unassessed?: readonly string[] };
  readonly callValidation?: { readonly input: unknown; readonly prepared: unknown };
}

const hostMessageShape030 = new SchemaChecker({ type: 'object', additionalProperties: false,
  properties: { prompt: { $ref: '#/$defs/instructions' }, resources: { $ref: '#/$defs/resources' } }, $defs: schema030.$defs });

/** Host messages have no route selectors. Shape and native content authority are separate. */
function validateHostMessage030(raw: unknown, document: ExactObject): { valid: boolean; shapeValid: boolean; unassessed: string[] } {
  const invalid = { valid: false, shapeValid: false, unassessed: [] as string[] };
  if (typeof raw !== 'string') return invalid;
  try {
    const message = record(decode(raw));
    if (hostMessageShape030.check(message).length) return invalid;
    const unassessed: string[] = [];
    const checkSource = (value: unknown) => {
      let source = record(value as never);
      if (has(source, 'ref')) {
        const content = record(document.content ?? {});
        if (typeof source.ref !== 'string' || !has(content, source.ref)) throw new ConformanceError('REFERENCE', '', 'Unknown content reference.');
        source = record(content[source.ref]);
      }
      if (has(source, 'uri')) unassessed.push('Native content capture for URI');
    };
    if (Array.isArray(message.prompt)) message.prompt.forEach(checkSource);
    if (has(message, 'resources')) {
      Object.values(record(message.resources)).forEach(checkSource);
      if (Object.keys(record(message.resources)).length) unassessed.push('Native resource delivery qualification');
    }
    return { valid: unassessed.length === 0, shapeValid: true, unassessed: [...new Set(unassessed)] };
  } catch (error) {
    if (error instanceof ConformanceError) return invalid;
    throw error;
  }
}
/** A size refusal belongs to this document. Correlation errors still reach the host failure path. */
export function encodeHostCompilation(result: CompilationResult030, registry: CapturedRegistry030, validations: Validations): string {
  const encoded = JSON.stringify({ ...result, capturedRegistryJson: JSON.stringify(registry), ...validations });
  if (new TextEncoder().encode(encoded).byteLength <= HOST_COMPILE_RESULT_LIMIT) return encoded;
  const diagnostic = { code: 'INPUT_LIMIT', pointer: '', message: 'Expanded compilation exceeds the native result limit.' };
  // Drop expanded declarations and reports, retaining the ticket's exact source,
  // registry version and validation inputs. No successful admission survives refusal.
  return JSON.stringify({
    static: { valid: result.static.valid, diagnostics: [] },
    runtime: { ...result.runtime, supported: false, diagnostics: [diagnostic], unassessed: [] },
    plan: null, compiledPlanJson: null, productRuntimeAvailable: false,
    entryValidation: validations.entryValidation && { messageJson: validations.entryValidation.messageJson, valid: false },
    deliveryValidation: validations.deliveryValidation && { input: validations.deliveryValidation.input, valid: false },
    callValidation: validations.callValidation && { input: validations.callValidation.input, prepared: null },
  });
}

/** The ticket owns correlation even when the reader cannot parse the source. */
export async function compileHost030(authored: string, source: SourceRevision, observation: CapturedRegistry030): Promise<string> {
  const { format, version, modules, harnesses, agents, hostCapabilities } = observation;
  const registry: CapturedRegistry030 = { format, version, modules, harnesses, agents,
    ...(hostCapabilities === undefined ? {} : { hostCapabilities }) };
  const result = await compilePlan030(authored, source, registry);
  const correlated = { ...result, runtime: { ...result.runtime, source, registryVersion: version } };
  const ticket = observation as CapturedRegistry030 & { startEntry?: { messageJson?: unknown } | null;
    deliveryInput?: unknown; callInput?: unknown };
  let document: ExactObject | null = null;
  let graph: ReturnType<typeof compileStaticGraph030> | null = null;
  if (result.static.valid) {
    try { document = record(decode(authored)); graph = compileStaticGraph030(document); }
    catch (error) { if (!(error instanceof ConformanceError)) throw error; }
  }
  const invalid = { valid: false, shapeValid: false, unassessed: [] as string[] };
  const entryMessage = ticket.startEntry?.messageJson ?? null;
  let entryCheck = document && graph?.entry ? validateHostMessage030(entryMessage, document)
    : document && graph && graph.entry === null && ticket.startEntry === null ? { valid: true, shapeValid: true, unassessed: [] } : invalid;
  const entryStep = graph?.steps.find(step => JSON.stringify(step.address) === JSON.stringify(graph?.entry));
  if (document && entryStep && entryCheck.valid && typeof entryMessage === 'string'
    && ['agent', 'approval', 'compose'].includes(entryStep.type)) {
    try {
      resolveRouteMessage030(authored as ExactJsonText,
        { kind: 'step', address: entryStep.address, stepJson: entryStep.declarationJson, declarationJson: entryStep.declarationJson },
        { kind: 'entry', terminalId: '', producerStep: null, outputJson: entryMessage as ExactJsonText, provenance: { instructions: [] } }, { kind: 'absent' });
    } catch (error) { if (!(error instanceof ConformanceError)) throw error; entryCheck = invalid; }
  }
  const input = ticket.deliveryInput;
  const delivery = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const deliveryCheck = document && graph && graph.entry === null && typeof delivery.agentName === 'string'
    && has(record(document.agents), delivery.agentName) ? validateHostMessage030(delivery.messageJson, document) : invalid;
  return encodeHostCompilation(correlated, registry, {
    ...(Object.hasOwn(ticket, 'startEntry') ? { entryValidation: { messageJson: entryMessage, ...entryCheck } } : {}),
    ...(Object.hasOwn(ticket, 'deliveryInput') ? { deliveryValidation: { input, ...deliveryCheck } } : {}),
    ...(Object.hasOwn(ticket, 'callInput') ? { callValidation: { input: ticket.callInput, prepared: null } } : {}),
  });
}
