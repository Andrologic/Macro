/** Lossless selections and authority-preserving AgSDL 0.3 message resolution. */
import type { ExactJsonText } from './contracts';
import { NumberToken, clone, decimal, decode, encode, equal, fail, has, list, record, text, type ExactObject, type ExactValue } from './exact';
import type { InstructionAuthority030, ItemContext030, PromptProvenance030, ResultMetadata030, RouteSource030, RouteTarget030 } from './routes030';

export interface CapturedContent030 {
  /** Consult already captured content only. Return a Source, not a delivery message. */
  readonly resolveSource?: (sourceJson: ExactJsonText, context: {
    readonly usage: 'prompt' | 'resource'; readonly pointer: string;
  }) => ExactJsonText;
}
export type SelectedValue030 =
  | { readonly kind: 'inline'; readonly valueJson: ExactJsonText; readonly mediaType?: string; readonly metadata?: ResultMetadata030 }
  | { readonly kind: 'file'; readonly sourceJson: ExactJsonText; readonly mediaType: string; readonly metadata: ResultMetadata030 };
export interface ResolvedMessage030 {
  readonly messageJson: ExactJsonText;
  readonly promptProvenance: PromptProvenance030;
}
const noPrompt: PromptProvenance030 = Object.freeze({ kind: 'none' });
const jsonMedia = (mediaType: string) => mediaType === 'application/json' || /^[^/]+\/[^/]+\+json$/.test(mediaType);

/** Raw traversal has no item namespace. Used for MCP operands and source fan-out. */
export function readPath030(current: ExactValue, path: ExactValue): ExactValue {
  if (!Array.isArray(path)) return fail('OPERAND', '', 'Selection path must be a list.');
  let value = current;
  for (const part of path) {
    if (typeof part === 'string' && value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof NumberToken)) {
      if (!has(value, part)) return fail('OPERAND', '', 'Missing selection property.');
      value = value[part];
    } else if (part instanceof NumberToken && Array.isArray(value)) {
      const [sign, digits, exponent] = decimal(part);
      if (sign || exponent < 0n || exponent > BigInt(String(value.length).length)) return fail('OPERAND', '', 'Invalid selection index.');
      const index = BigInt(digits) * 10n ** exponent;
      if (index >= BigInt(value.length)) return fail('OPERAND', '', 'Missing selection index.');
      value = value[Number(index)];
    } else return fail('OPERAND', '', 'Selection container does not match its path.');
  }
  return clone(value);
}
export function selectValue030(outputJson: ExactJsonText, pathJson: ExactJsonText, item: ItemContext030, metadata: readonly ResultMetadata030[] = []): SelectedValue030 {
  const path = list(decode(pathJson));
  const fromItem = path[0] === 'item';
  if (fromItem && item.kind === 'absent') return fail('OPERAND', '', 'No fan-out item in this message context.');
  const value = fromItem && item.kind === 'element'
    ? readPath030(decode(item.valueJson), path.slice(1))
    : readPath030(decode(outputJson), path);
  const result = !fromItem ? metadata.find(entry => equal(decode(entry.pathJson), path)) : undefined;
  if (result && !jsonMedia(result.mediaType) && !result.mediaType.startsWith('text/')) {
    const uri = text(value);
    try { new URL(uri); } catch { return fail('OPERAND', '', 'Media result requires an absolute file reference.'); }
    return { kind: 'file', sourceJson: encode({ uri, mediaType: result.mediaType }), mediaType: result.mediaType, metadata: result };
  }
  return { kind: 'inline', valueJson: encode(value), ...(result ? { mediaType: result.mediaType, metadata: result } : {}) };
}
/** The caller supplies accepted provenance; output shape alone grants no authority. */
export function instructionAuthority030(source: RouteSource030, pathJson: ExactJsonText): InstructionAuthority030 | undefined {
  const path = list(decode(pathJson));
  const valid = source.kind === 'agent'
    ? equal(path, ['instructions'])
    : source.kind === 'join' && path.length === 3 && path[0] === 'branches' && typeof path[1] === 'string' && path[2] === 'instructions';
  if (!valid) return undefined;
  const authority = source.provenance.instructions.find(entry => equal(decode(entry.pathJson), path)
    && (source.kind !== 'agent' || (entry.producerAgent === source.producerAgent && entry.terminalId === source.terminalId)));
  return authority ? Object.freeze({ ...authority }) : undefined;
}
function resultMetadata(document: ExactObject, source: RouteSource030): readonly ResultMetadata030[] {
  const declared: ResultMetadata030[] = [];
  if (source.kind === 'agent' && source.producerAgent) {
    const agents = record(document.agents ?? {});
    if (has(agents, source.producerAgent)) {
      const results = record(record(agents[source.producerAgent]).results ?? {});
      for (const [name, definition] of Object.entries(results)) declared.push({ pathJson: encode(['results', name]), mediaType: text(record(definition).mediaType ?? 'application/json') });
    }
  }
  // Captured metadata also describes join outputs and the effective composition producer.
  return [...declared.filter(entry => !source.provenance.results?.some(captured => equal(decode(captured.pathJson), decode(entry.pathJson)))), ...(source.provenance.results ?? [])];
}
export function resolveRouteMessage030(documentJson: ExactJsonText, target: RouteTarget030, source: RouteSource030, item: ItemContext030, content: CapturedContent030 = {}): ResolvedMessage030 {
  if (target.kind !== 'step') return fail('ROUTES', '', 'A composition output has no delivery message.');
  const step = record(decode(target.stepJson));
  if (!['agent', 'approval', 'compose'].includes(text(step.type))) return fail('ROUTES', '', 'This target receives no message.');
  const document = record(decode(documentJson)), output = record(decode(source.outputJson));
  const metadata = resultMetadata(document, source);
  let promptProvenance: PromptProvenance030 = noPrompt;
  const resolveSource = (raw: ExactValue, usage: 'prompt' | 'resource', pointer: string): ExactObject => {
    let resolved = record(raw);
    if (has(resolved, 'ref')) {
      if (Object.keys(resolved).length !== 1) return fail('REFERENCE', pointer, 'A content reference contains only ref.');
      const name = text(resolved.ref), catalog = record(document.content ?? {});
      if (!has(catalog, name)) return fail('REFERENCE', pointer, 'Unknown authored content reference.');
      resolved = record(catalog[name]);
    }
    if (Object.keys(resolved).some(key => !['value', 'uri', 'mediaType'].includes(key)) || has(resolved, 'value') === has(resolved, 'uri')) return fail('CONTENT_UNAVAILABLE', pointer, 'Expected one inline value or URI source.');
    if (has(resolved, 'mediaType')) text(resolved.mediaType);
    if (has(resolved, 'uri')) text(resolved.uri);
    const captured = content.resolveSource ? record(decode(content.resolveSource(encode(resolved), { usage, pointer }))) : clone(resolved);
    if (has(captured, 'value') === has(captured, 'uri') || has(captured, 'ref')) return fail('CONTENT_UNAVAILABLE', pointer, 'Captured content must be a resolved source.');
    if (usage === 'prompt' && has(captured, 'uri')) return fail('CONTENT_UNAVAILABLE', pointer, 'Prompt URI has not been captured as content.');
    return captured;
  };
  const authoredPrompt = (raw: ExactValue, pointer: string): ExactValue => {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.map((use, index) => resolveSource(use, 'prompt', `${pointer}/${index}`));
    return fail('MESSAGE_PATH', pointer, 'Expected authored prompt text or sources.');
  };
  const selectedResource = (pathJson: ExactJsonText, override?: ExactValue): ExactObject => {
    const selected = selectValue030(source.outputJson, pathJson, item, metadata);
    const resource = selected.kind === 'file' ? record(decode(selected.sourceJson)) : { value: decode(selected.valueJson), ...(selected.mediaType ? { mediaType: selected.mediaType } : {}) };
    if (override !== undefined) resource.mediaType = text(override);
    return resource;
  };
  const missionItemAuthority = (): InstructionAuthority030 => {
    const authority = instructionAuthority030(source, encode(['instructions']));
    if (item.kind !== 'element' || !item.mission || !authority || !item.instructionAuthority
      || item.instructionAuthority.terminalId !== authority.terminalId || item.instructionAuthority.producerAgent !== authority.producerAgent
      || !equal(decode(item.instructionAuthority.pathJson), decode(authority.pathJson))
      || target.eachPathJson === undefined || !equal(decode(target.eachPathJson), ['instructions'])) return fail('MESSAGE_PATH', '', 'Item has no authorized mission provenance.');
    const values = readPath030(output, ['instructions']);
    // The item must be the indexed element of the accepted list, not client-authored text.
    if (!/^(0|[1-9][0-9]*)$/.test(item.index) || !Array.isArray(values) || BigInt(item.index) >= BigInt(values.length)
      || !equal(values[Number(item.index)], decode(item.valueJson))) return fail('MESSAGE_PATH', '', 'Mission item differs from the accepted instructions.');
    return authority;
  };
  const selectedPrompt = (path: ExactValue): ExactValue => {
    if (equal(path, ['item'])) {
      const authority = missionItemAuthority();
      promptProvenance = { kind: 'agent', authority };
      return text(decode(item.kind === 'element' ? item.valueJson : encode(null)));
    }
    const authority = instructionAuthority030(source, encode(path));
    if (!authority) return fail('MESSAGE_PATH', '', 'Prompt selection requires authorized instructions.');
    promptProvenance = { kind: 'agent', authority };
    return text(readPath030(output, path));
  };
  let message: ExactObject;
  if (target.messageJson !== undefined) {
    const authored = record(decode(target.messageJson));
    if (Object.keys(authored).some(key => !['prompt', 'resources'].includes(key))) return fail('ROUTES', '', 'Authored message cannot add host fields.');
    message = {};
    if (has(authored, 'prompt')) {
      const prompt = authored.prompt;
      if (prompt !== null && typeof prompt === 'object' && !Array.isArray(prompt) && !(prompt instanceof NumberToken)) {
        if (Object.keys(prompt).length !== 1 || !has(prompt, 'from')) return fail('MESSAGE_PATH', '', 'Invalid prompt selection.');
        message.prompt = selectedPrompt(prompt.from);
      } else {
        message.prompt = authoredPrompt(prompt, '/message/prompt');
        promptProvenance = { kind: 'author', pointer: '/message/prompt' };
      }
    }
    if (has(authored, 'resources')) {
      message.resources = Object.fromEntries(Object.entries(record(authored.resources)).map(([name, raw]) => {
        const resource = record(raw);
        if (!has(resource, 'from')) return [name, resolveSource(resource, 'resource', `/message/resources/${name}`)];
        if (Object.keys(resource).some(key => !['from', 'mediaType'].includes(key))) return fail('MESSAGE_PATH', '', 'Invalid resource selection.');
        return [name, selectedResource(encode(resource.from), resource.mediaType)];
      }));
    }
  } else {
    switch (source.kind) {
      case 'entry':
        message = clone(output);
        if (has(message, 'prompt')) {
          message.prompt = authoredPrompt(message.prompt, '/entry/prompt');
          promptProvenance = { kind: 'host' };
        }
        if (has(message, 'resources')) message.resources = Object.fromEntries(Object.entries(record(message.resources)).map(([name, raw]) => [name, resolveSource(raw, 'resource', `/entry/resources/${name}`)]));
        break;
      case 'approval': {
        message = clone(record(output.message));
        if (has(message, 'prompt')) {
          promptProvenance = source.provenance.prompt ?? noPrompt;
          if (promptProvenance.kind === 'none') return fail('MESSAGE_PATH', '', 'Approval prompt requires inherited provenance.');
        }
        const comment = text(output.comment);
        if (comment !== '') {
          if (!source.producerStep) return fail('OPERAND', '', 'Approval comment requires its expanded step address.');
          message.comments = [...list(message.comments ?? []), { step: source.producerStep.join('/'), comment }];
        }
        break;
      }
      case 'agent': {
        const resources: ExactObject = Object.fromEntries(Object.keys(record(output.results ?? {})).map(name => [name, selectedResource(encode(['results', name]))]));
        if (has(resources, 'text')) return fail('OPERAND', '', 'Agent result cannot be named text.');
        resources.text = { value: text(output.text ?? ''), mediaType: 'text/plain' };
        message = { resources };
        const authority = instructionAuthority030(source, encode(['instructions']));
        if (authority) {
          if (item.kind === 'element' && item.mission) {
            missionItemAuthority();
            message.prompt = text(decode(item.valueJson));
          } else message.prompt = text(output.instructions);
          promptProvenance = { kind: 'agent', authority };
        }
        break;
      }
      case 'call': message = { resources: { result: { value: readPath030(output, ['data']) } } }; break;
      case 'join': message = { resources: Object.fromEntries(Object.entries(record(output.branches)).map(([name, value]) => [name, { value: clone(value) }])) }; break;
      case 'error': message = { resources: { error: { value: readPath030(output, ['error']) } } }; break;
    }
  }
  if (!has(message, 'prompt') && has(step, 'prompt')) {
    message.prompt = authoredPrompt(step.prompt, '/step/prompt');
    promptProvenance = { kind: 'author', pointer: '/step/prompt' };
  }
  if (item.kind === 'element') message.item = decode(item.valueJson);
  return { messageJson: encode(message), promptProvenance };
}
