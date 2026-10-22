import * as S from './shape.mjs';
import { Result, canonical, declaration, edition, equal, ext, key, localIndexComplete, modes, rows } from './core.mjs';

const RULES = ['P-SHAPE', 'X-MODE', 'R-SELECTION', 'R-BINDING', 'R-TOOL', 'R-CONTENT', 'R-COMPATIBILITY'];
const payloadShapes = { Tool: S.Tool, Instructions: S.Instructions, Skill: S.Skill };
const assessmentStates = { incompatible: 'declared', 'not-provided': 'absent', unknown: 'unknown', 'declared-supported': 'unchecked' };

export function validateR(ctx, inventory) {
  const result = new Result(ctx.id, 'R', 'unresolved-document', RULES);
  result.boundary(true);
  result.prerequisites = [ctx.d];
  if (ctx.d.verdict !== 'pass') result.mark('P-PREREQUISITE', 'blocked', '');
  modes(ctx, result, 'validateR');
  const interpreted = new Set();
  const state = (pointer, value, detail = value) => inventory.states.push({ input: ctx.id, pointer, state: value, detail });

  if (ctx.error || !S.object(ctx.tree)) {
    for (const rule of RULES.filter(rule => rule !== 'X-MODE')) result.mark(rule, 'blocked', '');
    return { result: result.finish(), interpreted };
  }
  if (!S.has(ctx.tree, 'runtime')) {
    for (const rule of RULES.filter(rule => rule !== 'X-MODE')) result.mark(rule, 'excluded', '/runtime');
    return { result: result.finish(), interpreted };
  }

  const runtime = ctx.tree.runtime;
  result.shape(S.Runtime, runtime, '/runtime');
  if (!S.object(runtime)) {
    for (const rule of RULES.filter(rule => !['P-SHAPE', 'X-MODE'].includes(rule))) result.mark(rule, 'blocked', '/runtime');
    return { result: result.finish(), interpreted };
  }

  const configurationsReadable = Array.isArray(runtime.configurations);
  const configurations = configurationsReadable ? runtime.configurations : [];
  if (!Array.isArray(runtime.configurations)) {
    for (const rule of ['R-SELECTION', 'R-BINDING', 'R-TOOL', 'R-CONTENT', 'R-COMPATIBILITY']) result.mark(rule, 'blocked', '/runtime');
  }

  const configurationIds = new Map();
  let configurationIndexComplete = configurationsReadable;
  for (const [index, configuration] of configurations.entries()) {
    if (typeof configuration?.id !== 'string' || !configuration.id) {
      configurationIndexComplete = false;
      continue;
    }
    const pointer = `/runtime/configurations/${index}`;
    const matches = configurationIds.get(configuration.id) || [];
    if (matches.length) result.find('R-SELECTION', pointer, 'Duplicate configuration id');
    matches.push({ configuration, pointer, index });
    configurationIds.set(configuration.id, matches);
  }

  if (S.valid(S.Runtime, runtime)) {
    state('/runtime/selected', S.has(runtime, 'selected') ? 'declared' : 'absent');
    for (const [ci, configuration] of configurations.entries()) {
      const cp = `/runtime/configurations/${ci}`;
      state(cp, 'declared');
      for (const [ai, binding] of configuration.agents.entries()) {
        const ap = `${cp}/agents/${ai}`;
        state(`${ap}/engine`, binding.engine === null ? 'absent' : 'declared');
        for (const [claimIndex, claim] of binding.claims.entries()) if (claim.evidence === null) state(`${ap}/claims/${claimIndex}/evidence`, 'unknown');
        for (const [ti, tool] of binding.tools.entries()) {
          const tp = `${ap}/tools/${ti}`;
          state(`${tp}/selected`, S.has(tool, 'selected') ? 'declared' : 'absent');
          for (const [choiceIndex, choice] of tool.choices.entries()) {
            for (const [claimIndex, claim] of choice.claims.entries()) {
              if (claim.evidence === null) state(`${tp}/choices/${choiceIndex}/claims/${claimIndex}/evidence`, 'unknown');
            }
          }
        }
      }
    }
  }

  let selected = null;
  if (!S.has(runtime, 'selected')) {
    result.mark('R-COMPATIBILITY', 'excluded', '/runtime');
  } else if (typeof runtime.selected !== 'string' || !runtime.selected) {
    result.mark('R-SELECTION', 'blocked', '/runtime');
    result.mark('R-COMPATIBILITY', 'blocked', '/runtime');
  } else {
    result.mark('R-SELECTION');
    const matches = configurationIds.get(runtime.selected);
    if (!matches && !configurationIndexComplete) {
      result.mark('R-SELECTION', 'blocked', '/runtime');
      result.mark('R-COMPATIBILITY', 'blocked', '/runtime');
    } else if (!matches) {
      result.find('R-SELECTION', '/runtime', 'Selected configuration does not exist');
      result.mark('R-COMPATIBILITY', 'blocked', '/runtime');
    } else if (matches.length !== 1) {
      result.mark('R-COMPATIBILITY', 'blocked', '/runtime');
    } else selected = matches[0];
  }

  const graphRows = Array.isArray(ctx.tree.graphs) ? ctx.tree.graphs.map((value, index) => ({ value, pointer: `/graphs/${index}` })) : null;
  const graphIndexReadable = graphRows !== null && graphRows.every(row => S.object(row.value) && S.valid(S.Key, row.value.definition));

  function graphFor(configuration, pointer) {
    if (!S.valid(S.Key, configuration?.graph) || !graphRows || !graphIndexReadable) {
      result.mark('R-SELECTION', 'blocked', pointer);
      return null;
    }
    const matches = graphRows.filter(row => equal(row.value.definition, configuration.graph));
    if (!matches.length) {
      result.mark('R-SELECTION');
      result.find('R-SELECTION', pointer, 'Configuration graph does not exist');
      return null;
    }
    if (matches.length !== 1) {
      result.mark('R-SELECTION', 'blocked', pointer);
      return null;
    }
    if (!declaration(ctx, configuration.graph, 'ControlFlow', result, 'R-SELECTION', pointer)) return null;
    result.mark('R-SELECTION');
    return matches[0];
  }

  function resolveRef(value, kind, rule, pointer, statePointer = pointer) {
    if (!S.valid(S.Ref, value)) {
      result.mark(rule, 'blocked', pointer);
      return { status: 'blocked', ref: value };
    }
    result.mark(rule);
    if (!declaration(ctx, value, kind, result, rule, pointer)) {
      if (ext(value)) return { status: 'blocked', ref: value };
      const found = ctx.defs.get(key(value));
      if (!localIndexComplete(ctx) || found?.length > 1) return { status: 'blocked', ref: value };
      if (found?.length === 1 && kind && !S.valid(S.Kind, found[0].v.kind)) return { status: 'blocked', ref: value };
      return { status: 'missing', ref: value };
    }
    if (ext(value)) {
      result.mark(rule, 'excluded', pointer);
      state(statePointer, 'unchecked');
      return { status: 'external', ref: value };
    }
    const found = ctx.defs.get(key(value))?.[0];
    return found ? { status: 'local', ref: value, ...found } : { status: 'blocked', ref: value };
  }

  function editionMap(values, rule, pointer) {
    const map = new Map();
    let blocked = false;
    if (!Array.isArray(values)) {
      result.mark(rule, 'blocked', pointer);
      return { map, blocked: true };
    }
    for (const value of values) {
      if (!S.valid(S.Edition, value)) {
        result.mark(rule, 'blocked', pointer);
        blocked = true;
        continue;
      }
      result.mark(rule);
      const identity = edition(value);
      if (map.has(identity)) {
        result.find(rule, pointer, 'Duplicate Edition');
        blocked = true;
      } else map.set(identity, value);
    }
    return { map, blocked };
  }

  function claimMap(claims, rule, pointer, reportDuplicates = true) {
    const map = new Map();
    const seen = new Set();
    const ambiguous = new Set();
    let indexComplete = true;
    let blocked = false;
    if (!Array.isArray(claims)) {
      result.mark(rule, 'blocked', pointer);
      return { map, ambiguous, indexComplete: false, blocked: true };
    }
    for (const claim of claims) {
      const validClaim = S.valid(S.CapabilityClaim, claim);
      if (!validClaim) {
        result.mark(rule, 'blocked', pointer);
        blocked = true;
      }
      if (!S.valid(S.Edition, claim?.capability)) { indexComplete = false; continue; }
      result.mark(rule);
      const identity = edition(claim.capability);
      if (seen.has(identity)) {
        if (reportDuplicates) result.find(rule, pointer, 'Duplicate capability claim');
        map.delete(identity);
        ambiguous.add(identity);
        blocked = true;
      } else if (validClaim) map.set(identity, claim);
      if (!validClaim) ambiguous.add(identity);
      seen.add(identity);
    }
    return { map, ambiguous, indexComplete, blocked };
  }

  function payload(found, kind, rule, requestingPointer) {
    if (found?.status !== 'local') return null;
    const pointer = `${found.p}/payload`;
    interpreted.add(pointer);
    const value = found.v.payload;
    const valid = result.shape(payloadShapes[kind], value, pointer);
    if (!S.object(value)) {
      result.mark(rule, 'blocked', requestingPointer || pointer);
      return { value: null, pointer, valid: false, found };
    }
    return { value, pointer, valid, found };
  }

  function projection(graph, configurationPointer) {
    if (!graph) return null;
    if (!Array.isArray(graph.value.steps)) {
      result.mark('R-BINDING', 'blocked', configurationPointer);
      return null;
    }
    const agents = [];
    for (const step of graph.value.steps) {
      if (!S.object(step) || !['invoke', 'condition', 'approval', 'end'].includes(step.kind) || (step.kind === 'invoke' && !S.valid(S.Ref, step.agent))) {
        result.mark('R-BINDING', 'blocked', configurationPointer);
        return null;
      }
      if (step.kind === 'invoke' && !agents.some(agent => canonical(agent) === canonical(step.agent))) agents.push(step.agent);
    }
    return agents;
  }

  const analyses = new Map();
  for (const [ci, configuration] of configurations.entries()) {
    const cp = `/runtime/configurations/${ci}`;
    if (!S.object(configuration)) {
      for (const rule of ['R-SELECTION', 'R-BINDING', 'R-TOOL', 'R-CONTENT']) result.mark(rule, 'blocked', cp);
      analyses.set(configuration, { cp, groups: new Map(), used: null, structuralBlocked: true });
      continue;
    }
    result.mark('R-SELECTION');
    const graph = graphFor(configuration, cp);
    const used = projection(graph, cp);
    const bindingsReadable = Array.isArray(configuration.agents);
    const bindings = bindingsReadable ? configuration.agents : [];
    let bindingIndexComplete = bindingsReadable;
    let structuralBlocked = !graph || !used || !bindingsReadable;
    if (!Array.isArray(configuration.agents)) for (const rule of ['R-BINDING', 'R-TOOL', 'R-CONTENT']) result.mark(rule, 'blocked', cp);

    const groups = new Map();
    const unindexed = [];
    for (const [ai, binding] of bindings.entries()) {
      const ap = `${cp}/agents/${ai}`;
      if (!S.object(binding)) {
        for (const rule of ['R-BINDING', 'R-TOOL', 'R-CONTENT']) result.mark(rule, 'blocked', ap);
        structuralBlocked = true;
        bindingIndexComplete = false;
        continue;
      }
      const agent = resolveRef(binding.agent, 'Agent', 'R-BINDING', ap, `${ap}/agent`);
      const requirements = editionMap(binding.requires, 'R-BINDING', ap);
      const claims = claimMap(binding.claims, 'R-BINDING', ap);
      let bindingBlocked = requirements.blocked || claims.blocked;
      if (binding.engine !== null && !S.valid(S.Edition, binding.engine)) {
        result.mark('R-BINDING', 'blocked', ap);
        bindingBlocked = true;
      } else result.mark('R-BINDING');
      if (!Array.isArray(binding.tools)) {
        result.mark('R-TOOL', 'blocked', ap);
      }
      if (!Array.isArray(binding.applications)) {
        result.mark('R-CONTENT', 'blocked', ap);
        bindingBlocked = true;
      }
      const item = { binding, ap, agent, requirements, claims, bindingBlocked };
      if (S.valid(S.Ref, binding.agent)) {
        const identity = canonical(binding.agent);
        const matches = groups.get(identity) || [];
        if (matches.length) result.find('R-BINDING', ap, 'Duplicate AgentBinding');
        matches.push(item);
        groups.set(identity, matches);
      } else {
        structuralBlocked = true;
        bindingIndexComplete = false;
        unindexed.push(item);
      }
    }

    if (used && bindingIndexComplete) {
      result.mark('R-BINDING');
      const needed = new Set(used.map(canonical));
      if (needed.size !== groups.size || [...needed].some(identity => !groups.has(identity))) {
        result.find('R-BINDING', cp, 'AgentBinding coverage differs from graph Agents');
      }
    }
    analyses.set(configuration, { cp, groups, unindexed, used, structuralBlocked });
  }

  function analyzeBinding(item, assess, forceAssessmentBlocked) {
    const { binding, ap, agent, requirements, claims } = item;
    let assessmentBlocked = item.bindingBlocked || forceAssessmentBlocked;
    let unknownExternal = agent.status === 'external';
    let missingContent = false;
    let contentClosureComplete = agent.status === 'local';
    let contentClosureBlocked = agent.status === 'blocked';
    let toolClosureComplete = agent.status === 'local';
    let toolClosureBlocked = agent.status === 'blocked';
    let toolClosureUnknown = agent.status === 'external';
    const engineRequirements = new Map(requirements.map);
    const requiredTools = new Map();
    const requiredContent = new Map();
    const content = new Map();
    const edges = [];

    function incompleteContentClosure(reason) {
      contentClosureComplete = false;
      if (reason === 'blocked') contentClosureBlocked = true;
      toolClosureComplete = false;
      if (reason === 'blocked') toolClosureBlocked = true;
      else toolClosureUnknown = true;
    }

    if (agent.status === 'external') {
      result.mark('R-CONTENT', 'excluded', ap);
      result.mark('R-TOOL', 'excluded', ap);
    } else if (agent.status !== 'local') {
      result.mark('R-CONTENT', 'blocked', ap);
      result.mark('R-TOOL', 'blocked', ap);
      assessmentBlocked = true;
      incompleteContentClosure('blocked');
    }

    const relationRows = rows(ctx, 'relations', S.Relation);
    const usableRelation = row => S.valid(S.Relation, {
      source: row.v?.source,
      relation: row.v?.relation,
      target: row.v?.target,
      expectedKind: row.v?.expectedKind,
    });
    if (agent.status === 'local') {
      if (!Array.isArray(ctx.tree.relations)) {
        result.mark('R-CONTENT', 'blocked', ap);
        result.mark('R-TOOL', 'blocked', ap);
        assessmentBlocked = true;
        incompleteContentClosure('blocked');
      } else {
        let contentRelationsBlocked = false;
        let toolRelationsBlocked = false;
        for (const relation of relationRows) {
          if (usableRelation(relation)) continue;
          if (S.valid(S.Key, relation.v?.source) && !equal(relation.v.source, agent.v.key)) continue;
          if (relation.v?.relation === 'uses') toolRelationsBlocked = true;
          else if (relation.v?.relation === 'directedBy' || !['actsAs', 'exposes', 'contains'].includes(relation.v?.relation)) {
            contentRelationsBlocked = true;
            toolRelationsBlocked = true;
          }
        }
        if (contentRelationsBlocked) {
          result.mark('R-CONTENT', 'blocked', ap);
          assessmentBlocked = true;
          contentClosureComplete = false;
          contentClosureBlocked = true;
        }
        if (toolRelationsBlocked) {
          result.mark('R-TOOL', 'blocked', ap);
          toolClosureComplete = false;
          toolClosureBlocked = true;
        }
      }
    }

    function rememberContent(ref, request, statePointer) {
      if (S.valid(S.Ref, ref)) requiredContent.set(canonical(ref), ref);
      return visitContent(ref, request, statePointer);
    }

    function rememberTool(ref, request, rule, statePointer) {
      if (!S.valid(S.Ref, ref)) {
        result.mark(rule, 'blocked', request);
        toolClosureComplete = false;
        toolClosureBlocked = true;
        return { status: 'blocked', ref };
      }
      const identity = canonical(ref);
      const found = resolveRef(ref, 'Tool', rule, request, statePointer);
      if (!requiredTools.has(identity)) requiredTools.set(identity, { ref, found, request });
      if (found.status === 'blocked') {
        toolClosureComplete = false;
        toolClosureBlocked = true;
      }
      return found;
    }

    const visiting = new Set();
    const complete = new Set();
    function visitContent(ref, request, statePointer = request) {
      const found = resolveRef(ref, null, 'R-CONTENT', request, statePointer);
      if (found.status === 'external') {
        unknownExternal = true;
        incompleteContentClosure('unknown');
        return found;
      }
      if (found.status === 'missing') {
        missingContent = true;
        incompleteContentClosure('unknown');
        return found;
      }
      if (found.status === 'blocked') {
        assessmentBlocked = true;
        incompleteContentClosure('blocked');
        return found;
      }

      const identity = canonical(ref);
      if (complete.has(identity) || visiting.has(identity)) return content.get(identity)?.found || found;
      visiting.add(identity);
      if (!S.valid(S.Kind, found.v.kind)) {
        result.mark('R-CONTENT', 'blocked', request);
        assessmentBlocked = true;
        incompleteContentClosure('blocked');
        visiting.delete(identity);
        return found;
      }
      if (!['Instructions', 'Skill'].includes(found.v.kind)) {
        result.find('R-CONTENT', request, 'Content target has wrong kind');
        missingContent = true;
        incompleteContentClosure('unknown');
        visiting.delete(identity);
        return found;
      }

      const info = payload(found, found.v.kind, 'R-CONTENT', request);
      content.set(identity, { found, info, kind: found.v.kind, ref });
      if (!info?.value) {
        assessmentBlocked = true;
        incompleteContentClosure('blocked');
      }
      else {
        const ownRequirements = editionMap(info.value.requires, 'R-CONTENT', info.pointer);
        for (const [capability, value] of ownRequirements.map) engineRequirements.set(capability, value);
        if (ownRequirements.blocked) assessmentBlocked = true;
        if (found.v.kind === 'Instructions') {
          if (S.valid(S.Edition, info.value.format)) engineRequirements.set(edition(info.value.format), info.value.format);
          else assessmentBlocked = true;
        } else {
          if (!Array.isArray(info.value.dependencies)) {
            result.mark('R-CONTENT', 'blocked', info.pointer);
            assessmentBlocked = true;
            incompleteContentClosure('blocked');
          } else {
            const seenDependencies = new Set();
            for (const [index, dependency] of info.value.dependencies.entries()) {
              if (!S.valid(S.Ref, dependency)) {
                result.mark('R-CONTENT', 'blocked', info.pointer);
                assessmentBlocked = true;
                incompleteContentClosure('blocked');
                continue;
              }
              const dependencyIdentity = canonical(dependency);
              if (seenDependencies.has(dependencyIdentity)) {
                result.find('R-CONTENT', info.pointer, 'Duplicate Skill dependency');
                assessmentBlocked = true;
              }
              seenDependencies.add(dependencyIdentity);
              edges.push([identity, dependencyIdentity]);
              requiredContent.set(dependencyIdentity, dependency);
              visitContent(dependency, info.pointer, `${info.pointer}/dependencies/${index}`);
            }
          }
          if (!Array.isArray(info.value.tools)) {
            result.mark('R-CONTENT', 'blocked', info.pointer);
            toolClosureComplete = false;
            toolClosureBlocked = true;
          } else {
            const seenTools = new Set();
            for (const [index, tool] of info.value.tools.entries()) {
              if (!S.valid(S.Ref, tool)) {
                result.mark('R-CONTENT', 'blocked', info.pointer);
                toolClosureComplete = false;
                toolClosureBlocked = true;
                continue;
              }
              const toolIdentity = canonical(tool);
              if (seenTools.has(toolIdentity)) {
                result.find('R-CONTENT', info.pointer, 'Duplicate Skill Tool');
              }
              seenTools.add(toolIdentity);
              rememberTool(tool, info.pointer, 'R-CONTENT', `${info.pointer}/tools/${index}`);
            }
          }
        }
      }
      visiting.delete(identity);
      complete.add(identity);
      return found;
    }

    if (agent.status === 'local') {
      for (const relation of relationRows.filter(row => usableRelation(row) && equal(row.v.source, agent.v.key))) {
        if (relation.v.relation === 'directedBy' && ['Instructions', 'Skill'].includes(relation.v.expectedKind)) rememberContent(relation.v.target, relation.p, `${relation.p}/target`);
        if (relation.v.relation === 'uses' && relation.v.expectedKind === 'Tool') rememberTool(relation.v.target, relation.p, 'R-TOOL', `${relation.p}/target`);
      }
    }

    const adjacency = new Map();
    for (const [from, to] of edges) adjacency.set(from, [...(adjacency.get(from) || []), to]);
    for (const [identity, entry] of content) {
      if (entry.kind !== 'Skill') continue;
      const seen = new Set();
      const pending = [...(adjacency.get(identity) || [])];
      let cycle = false;
      while (pending.length) {
        const next = pending.pop();
        if (next === identity) { cycle = true; break; }
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(...(adjacency.get(next) || []));
      }
      if (cycle && entry.info) result.find('R-CONTENT', entry.info.pointer, 'Skill dependency cycle');
    }

    const applications = Array.isArray(binding.applications) ? binding.applications : [];
    const extraContent = new Map();
    const extraTools = new Map();
    const extraEdges = [];
    function observeAdditionalContent(found, request) {
      if (found.status !== 'local' || !['Instructions', 'Skill'].includes(found.v.kind)) return;
      const identity = canonical(found.ref);
      if (content.has(identity) || extraContent.has(identity)) return;
      const info = payload(found, found.v.kind, 'R-CONTENT', request);
      extraContent.set(identity, { found, info, kind: found.v.kind });
      if (!info?.value) return;
      editionMap(info.value.requires, 'R-CONTENT', info.pointer);
      if (found.v.kind !== 'Skill') return;
      for (const field of ['dependencies', 'tools']) {
        const refs = info.value[field];
        if (!Array.isArray(refs)) { result.mark('R-CONTENT', 'blocked', info.pointer); continue; }
        const seen = new Set();
        for (const [index, ref] of refs.entries()) {
          if (!S.valid(S.Ref, ref)) { result.mark('R-CONTENT', 'blocked', info.pointer); continue; }
          const targetIdentity = canonical(ref);
          if (seen.has(targetIdentity)) result.find('R-CONTENT', info.pointer, field === 'tools' ? 'Duplicate Skill Tool' : 'Duplicate Skill dependency');
          seen.add(targetIdentity);
          const target = resolveRef(ref, field === 'tools' ? 'Tool' : null, 'R-CONTENT', info.pointer, `${info.pointer}/${field}/${index}`);
          if (field === 'tools') extraTools.set(targetIdentity, { found: target, request: info.pointer });
          else {
            extraEdges.push([identity, targetIdentity]);
            if (target.status === 'local' && !S.valid(S.Kind, target.v.kind)) result.mark('R-CONTENT', 'blocked', info.pointer);
            else if (target.status === 'local' && !['Instructions', 'Skill'].includes(target.v.kind)) result.find('R-CONTENT', info.pointer, 'Content target has wrong kind');
            else observeAdditionalContent(target, info.pointer);
          }
        }
      }
    }
    let applicationIndexComplete = Array.isArray(binding.applications);
    const unreadableApplicationPositions = [];
    const applicationPositions = new Map();
    for (const [index, application] of applications.entries()) {
      const pointer = `${ap}/applications/${index}`;
      if (!S.object(application)) {
        result.mark('R-CONTENT', 'blocked', pointer);
        assessmentBlocked = true;
        applicationIndexComplete = false;
        unreadableApplicationPositions.push(index);
        continue;
      }
      if (S.valid(S.Edition, application.adapter)) engineRequirements.set(edition(application.adapter), application.adapter);
      else assessmentBlocked = true;
      const found = resolveRef(application.content, null, 'R-CONTENT', pointer, `${pointer}/content`);
      if (found.status === 'external') unknownExternal = true;
      if (found.status === 'blocked') assessmentBlocked = true;
      if (found.status === 'local' && !S.valid(S.Kind, found.v.kind)) {
        result.mark('R-CONTENT', 'blocked', pointer);
        assessmentBlocked = true;
      } else if (found.status === 'local' && !['Instructions', 'Skill'].includes(found.v.kind)) {
        result.find('R-CONTENT', pointer, 'Application content has wrong kind');
      }
      if (found.status === 'local' && ['Instructions', 'Skill'].includes(found.v.kind)) {
        // A declared Application selects its payload even outside the required closure.
        // Intrinsic engine requirements still come only from the required closure.
        observeAdditionalContent(found, pointer);
      }
      if (!S.valid(S.Ref, application.content)) {
        applicationIndexComplete = false;
        unreadableApplicationPositions.push(index);
        continue;
      }
      const identity = canonical(application.content);
      applicationPositions.set(identity, [...(applicationPositions.get(identity) || []), index]);
    }

    for (const [identity, entry] of extraContent) {
      if (entry.found.v.kind !== 'Skill') continue;
      const seen = new Set(), pending = extraEdges.filter(([from]) => from === identity).map(([, to]) => to);
      while (pending.length) {
        const next = pending.pop();
        if (next === identity) { result.find('R-CONTENT', entry.info.pointer, 'Skill dependency cycle'); break; }
        if (seen.has(next)) continue;
        seen.add(next);
        pending.push(...extraEdges.filter(([from]) => from === next).map(([, to]) => to));
      }
    }

    if (applicationIndexComplete) {
      for (const identity of requiredContent.keys()) {
        if (!applicationPositions.has(identity)) {
          result.find('R-CONTENT', ap, 'Required Application missing');
          missingContent = true;
        }
      }
      for (const [, dependency] of extraEdges) if (!applicationPositions.has(dependency)) result.find('R-CONTENT', ap, 'Required Application missing');
    }
    const observedContent = new Map([...content, ...extraContent]);
    for (const [identity, entry] of observedContent) {
      if (entry.kind !== 'Skill' || !Array.isArray(entry.info?.value?.dependencies)) continue;
      const dependents = applicationPositions.get(identity) || [];
      for (const dependency of entry.info.value.dependencies) {
        if (!S.valid(S.Ref, dependency)) continue;
        const prerequisites = applicationPositions.get(canonical(dependency)) || [];
        for (const dependent of dependents) if (!prerequisites.some(prerequisite => prerequisite < dependent)) {
          if (unreadableApplicationPositions.some(position => position < dependent)) result.mark('R-CONTENT', 'blocked', `${ap}/applications/${dependent}`);
          else if (prerequisites.length) result.find('R-CONTENT', `${ap}/applications/${dependent}`, 'Skill dependency must appear earlier');
        }
      }
    }
    if (contentClosureComplete) {
      for (const [identity, positions] of applicationPositions) if (!requiredContent.has(identity)) {
        for (const position of positions) result.find('R-CONTENT', `${ap}/applications/${position}`, 'Application is not reachable from Agent direction');
      }
    } else {
      for (const [identity, positions] of applicationPositions) if (!requiredContent.has(identity)) {
        for (const position of positions) result.mark('R-CONTENT', contentClosureBlocked ? 'blocked' : 'excluded', `${ap}/applications/${position}`);
      }
    }
    for (const [identity, entry] of observedContent) if (entry.kind === 'Skill' && (!Array.isArray(entry.info?.value?.dependencies) || entry.info.value.dependencies.some(dependency => !S.valid(S.Ref, dependency)))) {
      for (const position of applicationPositions.get(identity) || []) result.mark('R-CONTENT', 'blocked', `${ap}/applications/${position}`);
    }

    const tools = Array.isArray(binding.tools) ? binding.tools : [];
    let toolIndexComplete = Array.isArray(binding.tools);
    const toolGroups = new Map();
    const unindexedTools = [];
    for (const [index, toolBinding] of tools.entries()) {
      const tp = `${ap}/tools/${index}`;
      if (!S.object(toolBinding)) {
        result.mark('R-TOOL', 'blocked', tp);
        assessmentBlocked = true;
        toolIndexComplete = false;
        continue;
      }
      const found = resolveRef(toolBinding.tool, 'Tool', 'R-TOOL', tp, `${tp}/tool`);
      const choiceIds = new Map();
      const choices = Array.isArray(toolBinding.choices) ? toolBinding.choices : [];
      let choiceBlocked = !Array.isArray(toolBinding.choices);
      let choiceIndexComplete = Array.isArray(toolBinding.choices);
      if (!Array.isArray(toolBinding.choices)) result.mark('R-TOOL', 'blocked', tp);
      for (const [choiceIndex, choice] of choices.entries()) {
        const choicePointer = `${tp}/choices/${choiceIndex}`;
        if (!S.object(choice)) {
          result.mark('R-TOOL', 'blocked', choicePointer);
          choiceBlocked = true;
          choiceIndexComplete = false;
          continue;
        }
        const choiceClaims = claimMap(choice.claims, 'R-TOOL', tp);
        let selectedChoiceBlocked = choiceClaims.blocked || !S.valid(S.Implementation, choice);
        if (typeof choice.id !== 'string' || !choice.id) {
          result.mark('R-TOOL', 'blocked', choicePointer);
          choiceBlocked = true;
          choiceIndexComplete = false;
          continue;
        }
        const matches = choiceIds.get(choice.id) || [];
        if (matches.length) {
          result.find('R-TOOL', choicePointer, 'Duplicate Implementation id');
        }
        matches.push({ choice, choicePointer, claims: choiceClaims, blocked: selectedChoiceBlocked });
        choiceIds.set(choice.id, matches);
      }
      let selection = { status: 'absent' };
      if (S.has(toolBinding, 'selected')) {
        if (typeof toolBinding.selected !== 'string' || !toolBinding.selected) {
          result.mark('R-TOOL', 'blocked', tp);
          selection = { status: 'blocked' };
        } else {
          const matches = choiceIds.get(toolBinding.selected);
          if (!matches && !choiceIndexComplete) {
            result.mark('R-TOOL', 'blocked', tp);
            selection = { status: 'blocked' };
          } else if (!matches) {
            result.find('R-TOOL', tp, 'Selected Implementation missing');
            selection = { status: 'blocked' };
          } else if (matches.length !== 1) {
            result.mark('R-TOOL', 'blocked', tp);
            selection = { status: 'blocked' };
          } else selection = { status: 'selected', ...matches[0] };
        }
      }
      const itemForTool = { toolBinding, tp, found, selection, choiceBlocked };
      if (S.valid(S.Ref, toolBinding.tool)) {
        const identity = canonical(toolBinding.tool);
        const matches = toolGroups.get(identity) || [];
        if (matches.length) result.find('R-TOOL', tp, 'Duplicate ToolBinding');
        matches.push(itemForTool);
        toolGroups.set(identity, matches);
      } else {
        toolIndexComplete = false;
        unindexedTools.push(itemForTool);
      }
    }

    const missingTool = toolIndexComplete && [...requiredTools.keys()].some(identity => !toolGroups.has(identity));
    const extraTool = [...toolGroups.keys()].some(identity => !requiredTools.has(identity));
    if (missingTool || (toolClosureComplete && extraTool)) result.find('R-TOOL', ap, 'ToolBinding coverage differs from required Tools');

    const toolPayloads = new Map();
    const observedTools = new Map([...extraTools, ...requiredTools]);
    for (const [identity, matches] of toolGroups) if (!observedTools.has(identity)) {
      const binding = matches[0];
      observedTools.set(identity, { found: binding.found, request: binding.tp });
    }
    for (const [identity, requirement] of observedTools) {
      const info = payload(requirement.found, 'Tool', 'R-TOOL', requirement.request);
      let blocked = requirement.found.status === 'blocked';
      if (info?.value) {
        const requirementsForTool = editionMap(info.value.requires, 'R-TOOL', info.pointer);
        if (requirementsForTool.blocked) blocked = true;
        if (!S.valid(S.Tool.fields.effects, info.value.effects)) blocked = true;
        if (Array.isArray(info.value.failures)) {
          const readableFailures = info.value.failures.filter(failure => typeof failure === 'string' && failure.length);
          if (readableFailures.length !== info.value.failures.length) {
            result.mark('R-TOOL', 'blocked', info.pointer);
            blocked = true;
          }
          if (new Set(readableFailures).size !== readableFailures.length) result.find('R-TOOL', info.pointer, 'Duplicate Tool failure');
        } else {
          result.mark('R-TOOL', 'blocked', info.pointer);
          blocked = true;
        }
        const action = resolveRef(info.value.action, 'Action', 'R-TOOL', info.pointer, `${info.pointer}/action`);
        if (action.status === 'blocked') blocked = true;
        toolPayloads.set(identity, { info, requirements: requirementsForTool.map, blocked });
      } else toolPayloads.set(identity, { info, requirements: new Map(), blocked: requirement.found.status !== 'external' });
    }

    if (!assess) return;
    for (const toolBinding of unindexedTools) assessTool(toolBinding, null, true, false);
    for (const [identity, matches] of toolGroups) {
      const required = requiredTools.has(identity);
      const payloadInfo = toolPayloads.get(identity);
      const uncertainMembership = !required && !toolClosureComplete && !toolClosureBlocked && toolClosureUnknown;
      for (const toolBinding of matches) assessTool(
        toolBinding,
        payloadInfo,
        forceAssessmentBlocked || matches.length !== 1 || (!required && (toolClosureComplete || toolClosureBlocked)),
        uncertainMembership,
      );
    }
    assessAgent();

    function evaluate(requirementMap, claimLookup, supplied, extraUnknown = false) {
      if (!supplied) return ['not-provided'];
      const values = [];
      for (const capability of requirementMap.values()) {
        const identity = edition(capability);
        if (claimLookup.ambiguous.has(identity)) continue;
        const claim = claimLookup.map.get(identity);
        if (!claim && !claimLookup.indexComplete) continue;
        if (claim?.status === 'unsupported') values.push('incompatible');
        else if (!claim || claim.status === 'unknown' || claim.evidence === null) values.push('unknown');
        else values.push('declared-supported');
      }
      if (extraUnknown) values.push('unknown');
      if (!values.length) values.push('declared-supported');
      return [...new Set(values)];
    }

    function recordAssessment(pointer, values, blocked = false) {
      result.mark('R-COMPATIBILITY');
      if (values.includes('incompatible')) result.find('R-COMPATIBILITY', pointer, 'Declared capability incompatible');
      if (values.some(value => ['not-provided', 'unknown'].includes(value))) result.find('R-COMPATIBILITY', pointer, 'Compatibility not established', 'inconclusive');
      if (blocked) {
        result.mark('R-COMPATIBILITY', 'blocked', pointer);
        state(pointer, 'unchecked', 'blocked');
        return;
      }
      const aggregate = values.includes('incompatible') ? 'incompatible' : values.includes('not-provided') ? 'not-provided' : values.includes('unknown') ? 'unknown' : 'declared-supported';
      state(pointer, assessmentStates[aggregate], aggregate);
    }

    function assessAgent() {
      const values = [...evaluate(engineRequirements, claims, binding.engine !== null, unknownExternal), ...(missingContent ? ['not-provided'] : [])];
      recordAssessment(ap, [...new Set(values)], assessmentBlocked || claims.blocked);
    }

    function assessTool(toolBinding, payloadInfo, forcedBlocked, uncertainMembership) {
      const { tp, selection } = toolBinding;
      if (selection.status === 'absent') {
        const values = uncertainMembership ? ['not-provided', 'unknown'] : ['not-provided'];
        recordAssessment(tp, values, forcedBlocked || toolBinding.choiceBlocked || payloadInfo?.blocked);
        return;
      }
      if (selection.status !== 'selected') {
        recordAssessment(tp, [], true);
        return;
      }
      const values = evaluate(payloadInfo?.requirements || new Map(), selection.claims, true, uncertainMembership || toolBinding.found.status === 'external' || payloadInfo?.info?.value?.effects === 'unknown');
      recordAssessment(tp, values, forcedBlocked || toolBinding.choiceBlocked || selection.blocked || selection.claims.blocked || payloadInfo?.blocked);
    }
  }

  for (const [configuration, analysis] of analyses) {
    const isSelected = selected?.configuration === configuration;
    const needed = new Set((analysis.used || []).map(canonical));
    for (const [identity, matches] of analysis.groups) {
      for (const item of matches) analyzeBinding(item, isSelected, analysis.structuralBlocked || matches.length !== 1 || !needed.has(identity));
    }
    for (const item of analysis.unindexed || []) analyzeBinding(item, isSelected, true);
    if (isSelected && analysis.structuralBlocked) result.mark('R-COMPATIBILITY', 'blocked', analysis.cp);
  }

  return { result: result.finish(), interpreted };
}
