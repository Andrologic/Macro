import { read } from '../../vendor/agsdl/v0.2/reader.mjs';
import { agentContent, inlineSource } from './content';
import type { Diagnostic, EngineVersions, ExactJsonText, FrozenAgentConfiguration, RuntimeAssessment, SourceRevision, StaticAssessment, StepAddress } from './contracts';
import { ConformanceError, NumberToken, at, clone, decode, encode, fail, has, list, record, text, type ExactObject, type ExactValue } from './exact';
import { PUBLICATION_PROTOCOL, captureAgent, resolveBinding, type CapturedRegistry } from './registry';

export const COMPILER_VERSION = 'macro-agsdl-inline-compiler/1' as const;
export const CONFORMANCE_VERSION = 'macro-agsdl-conformance/1' as const;
export const PRODUCT_RUNTIME_AVAILABLE = false as const;
export interface CompiledStep {
  readonly address: StepAddress;
  readonly declarationJson: ExactJsonText;
  /** Exact numeric token; the native admission owner converts to its canonical counter. */
  readonly maxVisitsJson: ExactJsonText | null;
  readonly routes: Readonly<Record<string, readonly StepAddress[]>>;
  readonly errorRoutes: readonly StepAddress[];
  readonly publicationContractJson: ExactJsonText | null;
}
export interface CompiledPlan {
  readonly format: 'macro-agsdl-compiled-plan/1';
  readonly versions: EngineVersions;
  readonly source: SourceRevision;
  readonly documentJson: ExactJsonText;
  readonly entry: StepAddress | null;
  readonly steps: readonly CompiledStep[];
  readonly agents: readonly FrozenAgentConfiguration[];
  readonly graphlessPublicationContracts: Readonly<Record<string, ExactJsonText | null>>;
}
export interface CompilationResult {
  readonly static: StaticAssessment;
  readonly runtime: RuntimeAssessment;
  readonly plan: CompiledPlan | null;
  readonly compiledPlanJson: ExactJsonText | null;
  readonly productRuntimeAvailable: false;
}
/** Credential key checks apply only to authored/effective settings, not public data or schemas. */
function rejectSettingsSecrets(value: ExactValue, pointer: string): void {
  if (value === null || typeof value !== 'object' || value instanceof NumberToken) return;
  for (const [key, child] of Object.entries(value)) {
    const path = at(pointer, key);
    if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credentials?)$/i.test(key)) {
      return fail('UNSUPPORTED', path, 'Secret-bearing input cannot be captured.');
    }
    rejectSettingsSecrets(child, path);
  }
}
function rejectAuthoredSettingsSecrets(document: ExactObject): void {
  for (const collection of ['bindings', 'configurations']) {
    for (const [name, value] of Object.entries(record(document[collection]))) {
      const declaration = record(value);
      if (has(declaration, 'settings')) rejectSettingsSecrets(declaration.settings, at(at(`/${collection}`, name), 'settings'));
    }
  }
}
function profilePreflight(document: ExactObject): void {
  if (has(document, 'compositions')) return fail('UNSUPPORTED', '/compositions', 'Compositions are outside this profile.');
  for (const [key, value] of Object.entries(record(document.content ?? {}))) inlineSource(value, at('/content', key));
  for (const [key, value] of Object.entries(record(document.agents))) {
    const agent = record(value);
    if (typeof agent.configuration !== 'string') return fail('UNSUPPORTED', `/agents/${key}/configuration`, 'Dynamic configurations are outside this profile.');
    agentContent(document, key);
    const interfaceValue = record(agent.interface ?? {});
    for (const mediaTypes of [interfaceValue.inputMediaTypes, interfaceValue.outputMediaTypes, ...Object.values(record(interfaceValue.results ?? {})).map(rule => record(rule).mediaTypes)]) {
      if (mediaTypes !== undefined && list(mediaTypes).some(type => type !== 'text/plain' && type !== 'application/json')) return fail('UNSUPPORTED', `/agents/${key}/interface`, 'Media interface is outside this profile.');
    }
  }
  // Reject unused authored media too: a captured declaration must be wholly within the profile.
  for (const [name, skill] of Object.entries(record(document.skills ?? {}))) {
    const container = record(skill);
    for (const use of [...list(container.prompt ?? []), ...Object.values(record(container.resources ?? {}))]) {
      const content = record(use);
      if (has(content, 'ref')) inlineSource(record(document.content ?? {})[text(content.ref)], `/skills/${name}`);
      else inlineSource(content, `/skills/${name}`);
    }
  }
  const flow = record(document.flow ?? {});
  for (const [name, value] of Object.entries(record(flow.steps ?? {}))) {
    const step = record(value), path = at('/flow/steps', name);
    if (!['agent', 'prepare', 'call', 'condition'].includes(text(step.type)) || step.delivery === 'steering' || has(step, 'steers')) return fail('UNSUPPORTED', path, 'This step is outside the serial inline profile.');
    const routes = Array.isArray(step.next) ? [step.next] : Object.values(record(step.next ?? {}));
    if ([...routes, step.onError ?? []].some(route => list(route).length > 1)) return fail('UNSUPPORTED', path, 'Fan-out is outside this profile.');
    if (step.type === 'prepare') {
      const message = record(step.message);
      for (const use of list(message.prompt ?? [])) {
        const content = record(use);
        inlineSource(has(content, 'ref') ? record(document.content ?? {})[text(content.ref)] : content, `${path}/message/prompt`);
      }
      for (const [key, use] of Object.entries(record(message.resources ?? {}))) {
        const content = record(use);
        if (has(content, 'select')) {
          if (has(content, 'mediaType') && content.mediaType !== 'text/plain' && content.mediaType !== 'application/json') return fail('UNSUPPORTED', `${path}/message/resources/${key}`, 'Unsupported selected format.');
          if (has(record(content.select), 'value')) inlineSource({ value: record(content.select).value, ...(has(content, 'mediaType') ? { mediaType: content.mediaType } : {}) });
        } else if (has(content, 'source')) {
          // Runtime selections are checked before delivery; authored literal Sources can be checked now.
          if (has(record(content.source), 'value')) inlineSource(record(content.source).value);
        } else inlineSource(has(content, 'ref') ? record(document.content ?? {})[text(content.ref)] : content);
      }
    }
  }
}
export async function sourceDigest(authoredSource: string): Promise<string> {
  const bytes = new TextEncoder().encode(authoredSource);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Called only after native canonical owner/revision lookup. SHA is checked again here.
 * No registration, admission, provider dispatch or side effects are performed.
 */
export async function compilePlan(authoredSource: string, source: SourceRevision, capturedRegistry: CapturedRegistry): Promise<CompilationResult> {
  const capturedSource = clone(source);
  const report = read(new TextEncoder().encode(authoredSource));
  const staticAssessment: StaticAssessment = { valid: report.valid, diagnostics: report.findings.map(finding => ({ code: finding.code, pointer: finding.path, message: finding.message ?? 'Document declaration is invalid.' })) };
  const registry = clone(capturedRegistry);
  let runtime: RuntimeAssessment = { profile: 'macro-serial-inline-v1', registryVersion: registry.version, source: clone(capturedSource), supported: false, diagnostics: [], unassessed: [] };
  const unavailable = (): CompilationResult => ({ static: staticAssessment, runtime, plan: null, compiledPlanJson: null, productRuntimeAvailable: false });
  if (!report.valid) return unavailable();
  try {
    if (!registry.version) return fail('UNSUPPORTED', '', 'Registry version is required.');
    if (!/^(0|[1-9][0-9]*)$/.test(capturedSource.revision) || !capturedSource.owner.projectId || !capturedSource.owner.planId || !capturedSource.owner.branch || capturedSource.sourceSha256 !== await sourceDigest(authoredSource)) return fail('CORRELATION', '', 'Canonical source revision or SHA does not match.');
    const document = record(decode(authoredSource));
    rejectAuthoredSettingsSecrets(document);
    profilePreflight(document);
    const agents = Object.keys(record(document.agents)).map(name => captureAgent(document, name, agentContent(document, name), registry));
    for (const agent of agents) {
      rejectSettingsSecrets(decode(agent.settingsJson), at(at('/agents', agent.agentName), 'effectiveSettings'));
    }
    const graphlessPublicationContracts: Record<string, ExactJsonText | null> = {};
    for (const name of Object.keys(record(document.agents))) {
      const agent = record(record(document.agents)[name]);
      const interfaceValue = record(agent.interface ?? {});
      graphlessPublicationContracts[name] = null;
      if (Object.keys(record(interfaceValue.results ?? {})).length) {
        const configuration = record(record(document.configurations)[text(agent.configuration)]);
        const engine = resolveBinding(document, text(configuration.engine), registry, 'engine');
        if (!engine.capabilities.includes('typed-publication')) return fail('UNSUPPORTED', `/agents/${name}`, 'Graphless output path has no verified typed publication support.');
        graphlessPublicationContracts[name] = encode({ protocol: PUBLICATION_PROTOCOL, registryVersion: registry.version, agent: name, step: null, interface: clone(interfaceValue), choices: [], decisionBinding: null });
      }
    }
    const flow = record(document.flow ?? {});
    const steps = Object.entries(record(flow.steps ?? {})).map(([name, value]): CompiledStep => {
      const step = record(value);
      if (step.type === 'call') resolveBinding(document, text(step.binding), registry, 'call');
      let publicationContractJson: ExactJsonText | null = null;
      if (step.type === 'agent') {
        const agent = record(record(document.agents)[text(step.agent)]);
        const interfaceValue = record(agent.interface ?? {});
        const choices = has(step, 'decision') ? list(record(step.decision).choices) : [];
        if (has(step, 'decision')) resolveBinding(document, text(record(step.decision).binding), registry, 'publication');
        if (Object.keys(record(interfaceValue.results ?? {})).length || choices.length) {
          const configuration = record(record(document.configurations)[text(agent.configuration)]);
          const engine = resolveBinding(document, text(configuration.engine), registry, 'engine');
          if (!engine.capabilities.includes('typed-publication')) return fail('UNSUPPORTED', `/flow/steps/${name}`, 'Engine has no verified typed publication path.');
          publicationContractJson = encode({ protocol: PUBLICATION_PROTOCOL, registryVersion: registry.version, agent: step.agent, step: [name], interface: clone(interfaceValue), choices: clone(choices), decisionBinding: has(step, 'decision') ? clone(record(document.bindings)[text(record(step.decision).binding)]) : null });
        }
      }
      const addresses = (destinations: ExactValue): StepAddress[] => list(destinations).map(destination => [text(destination)]);
      const routes = Array.isArray(step.next) || !has(step, 'next') ? { normal: addresses(step.next ?? []) } : Object.fromEntries(Object.entries(record(step.next)).map(([choice, targets]) => [choice, addresses(targets)]));
      return { address: [name], declarationJson: encode(step), maxVisitsJson: has(step, 'maxVisits') ? encode(step.maxVisits) : null, routes, errorRoutes: addresses(step.onError ?? []), publicationContractJson };
    });
    const plan: CompiledPlan = {
      format: 'macro-agsdl-compiled-plan/1',
      versions: { snapshot: '1', contract: 'agsdl-0.2.0', compiler: COMPILER_VERSION, runtime: CONFORMANCE_VERSION, registry: registry.version, profile: 'macro-serial-inline-v1' },
      source: clone(capturedSource), documentJson: encode(document), entry: has(flow, 'entry') ? [text(flow.entry)] : null, steps, agents, graphlessPublicationContracts,
    };
    runtime = { ...runtime, supported: true };
    // DTO numeric fields are exact JSON strings; declarations never traverse ordinary JSON parsing.
    const compiledPlanJson = encode(plan as unknown as ExactObject);
    return { static: staticAssessment, runtime, plan, compiledPlanJson, productRuntimeAvailable: PRODUCT_RUNTIME_AVAILABLE };
  } catch (error) {
    const diagnostic: Diagnostic = error instanceof ConformanceError ? { code: error.code, pointer: error.pointer, message: error.message } : { code: 'UNSUPPORTED', pointer: '', message: 'Incomplete or invalid trusted registry input.' };
    runtime = { ...runtime, diagnostics: [diagnostic] };
    return unavailable();
  }
}
