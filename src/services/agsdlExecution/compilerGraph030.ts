import { Graph, analyse_joins, step_routes, type JoinInfo } from '../../vendor/agsdl/v0.4/graph.mjs';
import { createAgentWorkContract030 } from './agentWorkContracts030';
import type { ExactJsonText, StepAddress } from './contracts';
import type { CompiledHandler030, CompiledJoin030, CompiledPlan030, CompiledRoute030, CompiledScope030, CompiledStep030, CompiledTarget030, ScopeAddress030 } from './contracts030';
import { decode, encode, fail, has, list, record, text, type ExactObject, type ExactValue } from './exact';
import { instructionsExpectation030, normalizeRoute030, type Scope030 } from './routes030';

type StaticGraph030 = Pick<CompiledPlan030, 'entry' | 'scopes' | 'steps' | 'routes' | 'joins' | 'handlers' | 'graphlessSubmissionContracts'>;
const address = (scope: ScopeAddress030, name: string): StepAddress => {
  const result: [string, ...string[]] = [name];
  result.unshift(...scope);
  return result;
};
const key = (parts: readonly string[]) => parts.join('/');
const numberJson = (decl: ExactObject, name: string) => has(decl, name) ? encode(decl[name]) : null;

/** Static expansion only. Group/instance/activation identities belong to the reducer. */
export function compileStaticGraph030(document: ExactObject): StaticGraph030 {
  const agents = record(document.agents), compositions = record(document.compositions ?? {});
  const scopes: CompiledScope030[] = [], steps: CompiledStep030[] = [], routes: CompiledRoute030[] = [];
  const joins: CompiledJoin030[] = [], handlers: CompiledHandler030[] = [];
  const joinsByComposition = new Map<string | null, Map<string, JoinInfo>>();
  let covered = new Set<string>();
  if (has(document, 'flow')) {
    const [initial] = analyse_joins(Graph.for_scope(document));
    const members = new Set([...initial.values()].flatMap(info => [...info.branches.values()].flatMap(branch => [...branch])));
    covered = Graph.flow_error_covered(document, members);
  }
  const scopeJoins = (composition: string | null) => {
    let infos = joinsByComposition.get(composition);
    if (!infos) {
      const [found, problems] = analyse_joins(Graph.for_scope(document, composition, composition === null ? covered : undefined));
      if (problems.length) fail('JOIN', '', 'Validated graph disagrees with join analysis.');
      infos = found;
      joinsByComposition.set(composition, infos);
    }
    return infos;
  };
  const resolveAgent = (ref: ExactValue, bindings: Readonly<Record<string, string>>): string => {
    const name = typeof ref === 'string' ? ref : bindings[text(record(ref).parameter)];
    if (!name || !has(agents, name)) return fail('REFERENCE', '', 'Composition parameter has no agent definition.');
    return name;
  };
  const visitScope = (container: ExactObject, scope: ScopeAddress030, parent: ScopeAddress030 | null,
    composition: string | null, bindings: Readonly<Record<string, string>>, stack: readonly string[]) => {
    const declarations = record(container.steps);
    const outputs = list(container.outputs ?? []).map(value => text(value));
    const routeScope: Scope030 = { prefix: scope, outputs,
      steps: Object.entries(declarations).map(([name, decl]) => ({ address: address(scope, name), declarationJson: encode(decl) })) };
    scopes.push({ address: scope, parent, composition, entry: address(scope, text(container.entry)), outputs, agents: bindings });
    const infos = scopeJoins(composition);
    for (const [name, value] of Object.entries(declarations)) {
      const decl = record(value), step = address(scope, name), type = text(decl.type) as CompiledStep030['type'];
      const agent = type === 'agent' ? resolveAgent(decl.agent, bindings) : null;
      const instance = type !== 'agent' ? null : !has(decl, 'instance') ? { kind: 'shared' as const }
        : decl.instance === 'new' ? { kind: 'new' as const } : { kind: 'named' as const, name: text(decl.instance) };
      steps.push({ address: step, scope, type, declarationJson: encode(decl), agent, instance,
        delivery: type !== 'agent' || instance?.kind === 'new' ? null : decl.delivery === 'steer' ? 'steer' : 'queue',
        maxVisitsJson: numberJson(decl, 'maxVisits'), timeoutMsJson: numberJson(decl, 'timeoutMs'), submissionContractJson: null });
      const addRoute = (kind: 'normal' | 'error', choice: string | null, raw: ExactValue, inherited: boolean) => {
        const declarationJson = encode(raw);
        const targets = normalizeRoute030(declarationJson, routeScope).map((target): CompiledTarget030 => target.kind === 'output'
          ? { kind: 'output', scope, name: target.name }
          : { kind: 'step', address: target.address, messageJson: target.messageJson ?? null,
              eachPathJson: target.eachPathJson ?? null, concurrencyJson: target.concurrencyJson ?? null, maxJson: target.maxJson ?? null });
        routes.push({ source: step, kind, key: choice, declarationJson, targets, inherited });
      };
      for (const [kind, choice, raw] of step_routes(decl, [])) addRoute(kind, choice, raw as ExactValue, false);
      if (!has(decl, 'next')) addRoute('normal', null, [], false);
      const flow = composition === null && covered.has(name);
      if (flow) addRoute('error', null, container.onError, true);
      const containing = [...infos].flatMap(([join, info]) => [...info.branches].filter(([, members]) => members.has(name))
        .map(([start, members]) => ({ join: address(scope, join), branch: info.names.get(start)!, size: members.size })));
      containing.sort((a, b) => a.size - b.size || key(a.join).localeCompare(key(b.join), 'en'));
      handlers.push({ address: step, scope, local: has(decl, 'onError'), flow,
        joins: containing.map(({ join, branch }) => ({ join, branch })) });
      if (type === 'join') {
        const info = infos.get(name);
        if (!info) fail('JOIN', '', 'Validated join has no origin.');
        const quorum = has(decl, 'quorum') ? record(decl.quorum) : null;
        joins.push({ address: step, scope, origin: address(scope, info.origin),
          branches: [...info.branches].map(([target, members]) => ({ name: info.names.get(target)!, target: address(scope, target),
            members: [...members].map(member => address(scope, member)), fanout: info.fanout.has(target) })),
          mode: quorum ? 'quorum' : 'all', failures: decl.failures === 'keep' ? 'keep' : 'fail',
          maxFailuresJson: numberJson(decl, 'maxFailures'), quorumCountJson: quorum ? encode(quorum.count) : null,
          accept: quorum ? list(quorum.accept).map(value => text(value)) : [],
          remaining: decl.remaining === 'finish' || decl.remaining === 'wait' ? decl.remaining : 'stop' });
      }
      if (type === 'compose') {
        const target = text(decl.composition);
        if (stack.includes(target)) fail('COMPOSITION', '', 'Composition cycle reached the compiler.');
        const childBindings = Object.fromEntries(Object.entries(record(decl.agents ?? {})).map(([parameter, ref]) => [parameter, resolveAgent(ref, bindings)]));
        visitScope(record(compositions[target]), step, scope, target, childBindings, [...stack, target]);
      }
    }
  };
  if (has(document, 'flow')) visitScope(record(document.flow), [], null, null, {}, []);

  // For a body's submission, an output reads the compose's route using the same
  // producer. Resolve just these static exits; the reducer still owns execution.
  const effectiveTargets = (targets: readonly CompiledTarget030[]): Extract<CompiledTarget030, { kind: 'step' }>[] => targets.flatMap(target => {
    if (target.kind === 'step') return [target];
    const outward = routes.find(route => key(route.source) === key(target.scope) && route.kind === 'normal' && route.key === target.name);
    if (!outward) return fail('COMPOSITION', '', 'Composition output has no enclosing route.');
    return effectiveTargets(outward.targets);
  });
  const expectationScope: Scope030 = { steps: steps.map(step => ({ address: [key(step.address)], declarationJson: step.declarationJson })) };
  const expectation = (agentJson: ExactJsonText, route: CompiledRoute030) => {
    const targets = effectiveTargets(route.targets).map(target => ({ step: key(target.address),
      ...(target.messageJson !== null ? { message: decode(target.messageJson) } : {}),
      ...(target.eachPathJson !== null ? { each: decode(target.eachPathJson) } : {}),
      ...(target.concurrencyJson !== null ? { concurrency: decode(target.concurrencyJson) } : {}),
      ...(target.maxJson !== null ? { max: decode(target.maxJson) } : {}) }));
    return instructionsExpectation030(agentJson, encode(targets), expectationScope);
  };
  const contractedSteps = steps.map(step => {
    if (step.agent === null) return step;
    const agentJson = encode(agents[step.agent]);
    const normal = routes.filter(route => key(route.source) === key(step.address) && route.kind === 'normal');
    const choices = normal[0]?.key === null ? null : normal.map(route => route.key!);
    const contract = createAgentWorkContract030({ agentJson, choices,
      instructionsByChoice: choices === null ? {} : Object.fromEntries(normal.map(route => [route.key!, expectation(agentJson, route)])),
      defaultInstructions: choices === null ? expectation(agentJson, normal[0]) : 'none', timeoutMs: step.timeoutMsJson });
    return { ...step, submissionContractJson: encode(contract as unknown as ExactObject) };
  });
  const graphlessSubmissionContracts = Object.fromEntries(Object.entries(agents).map(([name, agent]) =>
    [name, encode(createAgentWorkContract030({ agentJson: encode(agent) }) as unknown as ExactObject)]));
  return { entry: scopes[0]?.entry ?? null, scopes, steps: contractedSteps, routes, joins, handlers, graphlessSubmissionContracts };
}
