import { loadHarnessModule, read } from '../../vendor/agsdl/v0.3/reader.mjs';
import { readExactDocument } from '../agsdl/document';
import { compileStaticGraph030 } from './compilerGraph030';
import { captureAgent030, captureRegistry030, usedProperties030 } from './configuration030';
import type { SourceRevision } from './contracts';
import { COMPILED_PLAN_FORMAT030, EXECUTION_PROFILE030, type CapturedRegistry030, type CompilationResult030, type CompiledPlan030, type Diagnostic030, type RuntimeAssessment030 } from './contracts030';
import { at, ConformanceError, clone, decode, encode, fail, has, record, type ExactObject } from './exact';
import { captureSourceRevision } from './metadata';

export const COMPILER_VERSION030 = 'macro-agsdl-compiler/030' as const;
export const RUNTIME_VERSION030 = 'macro-agsdl-runtime/030' as const;

const reportToAssessment = (report: ReturnType<typeof read>): CompilationResult030['static'] => ({ valid: report.valid,
  diagnostics: report.diagnostics.map((finding): Diagnostic030 => ({ code: finding.code, pointer: finding.path,
    message: finding.message, severity: finding.severity, ...(finding.step?.length ? { step: finding.step as [string, ...string[]] } : {}) })) });

/** Pure capture/compilation. Native admission authenticates the observations. */
export async function compilePlan030(authoredSource: string, source: SourceRevision, input: CapturedRegistry030): Promise<CompilationResult030> {
  let assessment: CompilationResult030['static'] = { valid: false, diagnostics: [] };
  let runtime: RuntimeAssessment030 = { profile: EXECUTION_PROFILE030, registryVersion: '', source: null, supported: false, diagnostics: [], unassessed: [] };
  const unavailable = (): CompilationResult030 => ({ static: assessment, runtime, plan: null, compiledPlanJson: null, productRuntimeAvailable: false });
  try {
    if (typeof authoredSource !== 'string') fail('PARSE', '', 'Authored source must be primitive text.');
    const bytes = new TextEncoder().encode(authoredSource);
    let document: ExactObject;
    try { document = readExactDocument(authoredSource) as ExactObject; }
    catch {
      assessment = reportToAssessment(read(bytes, { modules: new Map() }));
      // TextEncoder replaces lone surrogates. Preserve the exact reader's refusal
      // even if the replaced bytes describe an otherwise valid document.
      if (assessment.valid) assessment = { valid: false, diagnostics: [{ code: 'PARSE', pointer: '', severity: 'error', message: 'Invalid exact JSON source.' }] };
      return unavailable();
    }
    // Assess syntax/references even when the registry is malformed. No module is
    // assumed until its native capture has passed the registry boundary.
    assessment = reportToAssessment(read(bytes, { modules: new Map() }));
    const capturedSource = captureSourceRevision(source);
    runtime = { ...runtime, source: capturedSource };
    const registry = captureRegistry030(input);
    runtime = { ...runtime, registryVersion: registry.version };
    const modules = new Map(registry.modules.map(entry => [entry.harness, loadHarnessModule(new TextEncoder().encode(entry.moduleJson))]));
    // Module coverage is advisory. The native range receipts used for authored
    // restrictions do not by themselves evaluate the module's coverage range.
    runtime = { ...runtime, unassessed: registry.harnesses.flatMap(observation => {
      const module = modules.get(observation.harness);
      return module && observation.installation === 'available'
        ? [`Harness ${observation.harness} version ${observation.version ?? 'unknown'} against module range ${module.harnessVersions}`]
        : [];
    }) };
    assessment = reportToAssessment(read(bytes, { modules }));
    if (!assessment.valid) return unavailable();
    // Everything caller-owned is copied before the asynchronous digest.
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (capturedSource.sourceSha256 !== digest) fail('CORRELATION', '/source/sourceSha256', 'Captured SHA does not match authored bytes.');
    const documentJson = encode(document);
    const agents = Object.keys(record(document.agents)).map(name => captureAgent030(documentJson, name, registry));
    const runtimeWarnings: Diagnostic030[] = [];
    for (const agent of agents) {
      const definition = record(record(document.agents)[agent.agentName]);
      const observation = registry.harnesses.find(harness => harness.harness === agent.harness)!;
      const module = modules.get(agent.harness);
      for (const [name, pointer] of usedProperties030(document, agent.agentName, definition, at('/agents', agent.agentName))) {
        const capability = observation.capabilities.find(candidate => candidate.name === name);
        const staticSupport = module?.properties[name as keyof typeof module.properties];
        if (capability?.support === 'approximate' && staticSupport?.support !== 'approximate') {
          runtimeWarnings.push({ code: 'HARNESS_APPROXIMATE', pointer, severity: 'warning',
            message: `The observed ${agent.harness} adapter approximates ${name}.` });
        }
      }
    }
    const graph = compileStaticGraph030(document);
    for (const step of graph.steps) {
      const declaration = record(decode(step.declarationJson));
      const required = step.type === 'call' ? has(declaration, 'command') ? 'call.command' : 'call.mcp'
        : step.type === 'approval' ? 'approval' : null;
      if (required && !registry.hostCapabilities?.some(capability => capability.name === required && capability.support === 'native')) {
        const scope = graph.scopes.find(candidate => candidate.address.join('/') === step.scope.join('/'));
        const owner = scope?.composition ? `/compositions/${scope.composition}` : '/flow';
        fail('HOST_CAPABILITY', `${owner}/steps/${step.address.at(-1)}`, `No native host qualification for ${required}.`);
      }
    }
    const plan: CompiledPlan030 = { format: COMPILED_PLAN_FORMAT030,
      versions: { snapshot: '2', contract: 'agsdl-0.3.0', compiler: COMPILER_VERSION030, runtime: RUNTIME_VERSION030,
        registry: registry.version, profile: EXECUTION_PROFILE030 }, source: clone(capturedSource), documentJson, agents, ...graph };
    const compiledPlanJson = encode(plan as unknown as ExactObject);
    runtime = { ...runtime, supported: true, diagnostics: runtimeWarnings };
    // Product activation is qualified by lot09, not by successful compilation.
    return { static: assessment, runtime, plan, compiledPlanJson, productRuntimeAvailable: false };
  } catch (error) {
    const diagnostic: Diagnostic030 = error instanceof ConformanceError
      ? { code: error.code, pointer: error.pointer, message: error.message, severity: 'error' }
      : { code: 'COMPILATION', pointer: '', message: 'Invalid compilation input or inconsistent dependency contract.', severity: 'error' };
    if (!assessment.diagnostics.length && !assessment.valid) assessment = { valid: false, diagnostics: [{ ...diagnostic, code: 'PARSE' }] };
    else runtime = { ...runtime, supported: false, diagnostics: [diagnostic] };
    return unavailable();
  }
}
