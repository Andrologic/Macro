import {
  entries,
  own,
  object,
  equal,
  duplicates,
  clone,
  pointer,
} from './values.mjs';
const routeLists = (s) =>
  Array.isArray(s.next)
    ? [['next', s.next]]
    : entries(s.next).map(([k, v]) => [`next/${k}`, v]);
const edges = (s) => [
  ...routeLists(s).flatMap(([, xs]) => xs),
  ...(s.onError ?? []),
];
const key = (x) => JSON.stringify(x);
const sameSet = (a, b) =>
  a.every((x) => b.some((y) => equal(x, y))) &&
  b.every((x) => a.some((y) => equal(x, y)));
const reach = (steps, start, stop = new Set()) => {
  const seen = new Set(),
    todo = [start];
  while (todo.length) {
    const x = todo.pop();
    if (stop.has(x) || seen.has(x) || !steps.has(x)) continue;
    seen.add(x);
    todo.push(...edges(steps.get(x).step).map(key));
  }
  return seen;
};

export function checkGraphs(doc, report, add) {
  const compositions = doc.compositions ?? {},
    top = doc.flow?.steps ?? {};
  const ref = (map, name, path) => {
    if (!own(map, name)) add('REFERENCE', path, `Unknown reference ${name}`);
  };
  const distinct = (xs, p) => {
    if (duplicates(xs)) add('DUPLICATE', p, 'Repeated declaration');
  };
  function localStep(s, p, body, invocation = null) {
    const fail = (code, path, message) => add(code, path, message, invocation);
    const reference = (map, name, path) => {
      if (!own(map, name)) fail('REFERENCE', path, `Unknown reference ${name}`);
    };
    if (s.type === 'agent') {
      if (typeof s.agent === 'string')
        reference(doc.agents, s.agent, pointer(p, 'agent'));
      else if (!(body.agentParameters ?? []).includes(s.agent.parameter))
        fail('COMPOSITION', pointer(p, 'agent'), 'Unknown Agent parameter');
      if (s.decision) {
        reference(
          doc.bindings,
          s.decision.binding,
          pointer(pointer(p, 'decision'), 'binding'),
        );
        if (duplicates(s.decision.choices))
          fail(
            'DUPLICATE',
            pointer(pointer(p, 'decision'), 'choices'),
            'Repeated decision choice',
          );
        if (
          !object(s.next) ||
          !sameSet(Object.keys(s.next), s.decision.choices)
        )
          fail(
            'ROUTES',
            pointer(p, 'next'),
            'Decision routes differ from choices',
          );
      } else if (own(s, 'next') && !Array.isArray(s.next))
        fail(
          'ROUTES',
          pointer(p, 'next'),
          'Agent without decision needs ordinary routes',
        );
    }
    if (['call', 'approval'].includes(s.type))
      reference(doc.bindings, s.binding, pointer(p, 'binding'));
    if (s.type === 'prepare') {
      for (const [i, v] of (s.message.prompt ?? []).entries())
        if (own(v, 'ref'))
          reference(doc.content, v.ref, `${p}/message/prompt/${i}/ref`);
      for (const [n, v] of entries(s.message.resources))
        if (own(v, 'ref'))
          reference(
            doc.content,
            v.ref,
            pointer(`${p}/message/resources`, n) + '/ref',
          );
    }
    if (s.scope && duplicates(s.scope.resources))
      fail(
        'DUPLICATE',
        pointer(pointer(p, 'scope'), 'resources'),
        'Repeated scope resource',
      );
    if (
      s.type === 'call' &&
      ['external', 'unknown'].includes(doc.bindings[s.binding]?.effects) &&
      !s.scope
    )
      fail('SCOPE', p, 'Effectful Call needs scope');
  }
  // Authored body checks precede expansion; unused bodies are checked as well.
  for (const [name, c] of entries(compositions)) {
    const p = pointer('/compositions', name);
    distinct(c.agentParameters ?? [], p);
    distinct(c.outputs, p);
    ref(c.steps, c.entry, pointer(p, 'entry'));
    const exports = new Set(),
      seen = new Set(),
      todo = [c.entry];
    while (todo.length) {
      const n = todo.pop();
      if (seen.has(n) || !own(c.steps, n)) continue;
      seen.add(n);
      todo.push(...edges(c.steps[n]).filter((x) => typeof x === 'string'));
    }
    for (const [n, s] of entries(c.steps)) {
      const sp = pointer(pointer(p, 'steps'), n);
      localStep(s, sp, c);
      if (!seen.has(n)) add('UNREACHABLE', sp, 'Unreachable body step');
      const routes = routeLists(s);
      if (!own(s, 'next'))
        add(
          'COMPOSITION',
          pointer(sp, 'next'),
          'Body needs explicit normal route',
        );
      for (const [r, xs] of routes) {
        if (xs.length !== 1)
          add('COMPOSITION', `${sp}/next`, 'Body routes have one target');
        distinct(xs, sp);
        for (const x of xs) {
          if (typeof x === 'string') ref(c.steps, x, sp);
          else if (!c.outputs.includes(x.output))
            add('COMPOSITION', `${sp}/next`, 'Unknown output export');
          else exports.add(x.output);
        }
      }
      if ((s.onError ?? []).length > 1)
        add(
          'COMPOSITION',
          pointer(sp, 'onError'),
          'Body error route has at most one target',
        );
      distinct(s.onError ?? [], sp);
      for (const x of s.onError ?? [])
        if (typeof x === 'string') ref(c.steps, x, sp);
    }
    for (const o of c.outputs)
      if (!exports.has(o))
        add(
          'COMPOSITION',
          pointer(p, 'outputs'),
          'Declared output lacks export',
        );
    // Check approval structure independently of whether a body is invoked.
    const records = new Map(
      entries(c.steps).map(([n, s]) => [
        key([n]),
        {
          address: [n],
          step: translate(
            s,
            (x) => (typeof x === 'string' ? [[x]] : []),
            (x) => (typeof x === 'string' ? [x] : x),
          ),
          source: pointer(pointer(p, 'steps'), n),
          invocation: null,
        },
      ]),
    );
    approvals(records, key([c.entry]));
  }
  for (const [n, s] of entries(top)) {
    const p = pointer('/flow/steps', n);
    for (const [field, code] of [
      ['call', 'APPROVAL'],
      ['steers', 'STEERING'],
    ])
      if (own(s, field) && top[s[field]]?.type === 'compose')
        add(code, pointer(p, field), 'Target must name actual body action');
    localStep(s, p, null);
    for (const [r, xs] of [...routeLists(s), ['onError', s.onError ?? []]]) {
      distinct(xs, p);
      for (const x of xs) ref(top, x, p);
    }
    if (s.type === 'compose') {
      if (
        entries(top).some(
          ([, other]) => other.type === 'join' && other.members.includes(n),
        )
      )
        add('COMPOSITION', p, 'Composition cannot be a direct Join member');
      ref(compositions, s.composition, pointer(p, 'composition'));
      const c = own(compositions, s.composition)
        ? compositions[s.composition]
        : undefined;
      for (const [k, a] of entries(s.agents))
        ref(doc.agents, a, pointer(pointer(p, 'agents'), k));
      if (c) {
        if (
          !sameSet(Object.keys(s.agents), [...new Set(c.agentParameters ?? [])])
        )
          add('COMPOSITION', p, 'Agent parameter map must be exact');
        if (!sameSet(Object.keys(s.next), [...new Set(c.outputs)]))
          add('COMPOSITION', p, 'Output map must be exact');
      }
    }
  }
  if (!doc.flow) return;
  ref(top, doc.flow.entry, '/flow/entry');
  // Invalid projections preserve addresses for diagnostic comparison only.
  const address = (n) =>
    top[n]?.type === 'compose' && own(compositions, top[n].composition)
      ? [n, compositions[top[n].composition].entry]
      : [n];
  const records = new Map();
  for (const [n, s] of entries(top)) {
    const inv = pointer('/flow/steps', n);
    if (s.type !== 'compose')
      records.set(key([n]), {
        address: [n],
        step: translate(s, (x) => [address(x)], address),
        source: inv,
        invocation: null,
      });
    else {
      const c = own(compositions, s.composition)
        ? compositions[s.composition]
        : undefined;
      if (!c) continue;
      for (const [local, original] of entries(c.steps)) {
        const redirect = (x, error = false) =>
          typeof x === 'string'
            ? [[n, x]]
            : (error ? (s.onError ?? []) : (s.next[x.output] ?? [])).map(
                address,
              );
        const step = translate(original, redirect, (x) => [n, x]);
        if (object(step.agent))
          step.agent = s.agents[step.agent.parameter] ?? '';
        records.set(key([n, local]), {
          address: [n, local],
          step,
          source: pointer(
            pointer(pointer('/compositions', s.composition), 'steps'),
            local,
          ),
          invocation: inv,
        });
      }
    }
  }
  const entry = key(address(doc.flow.entry));
  if (!records.has(entry))
    add('REFERENCE', '/flow/entry', 'Expanded entry is unavailable');
  const emit = (code, r, field, msg) =>
    add(code, r.source + (field ? `/${field}` : ''), msg, r.invocation);
  const seen = reach(records, entry);
  for (const [id, r] of records) {
    const s = r.step;
    for (const [, xs] of [...routeLists(s), ['onError', s.onError ?? []]]) {
      if (duplicates(xs)) emit('DUPLICATE', r, '', 'Repeated destination');
      if (xs.some((x) => !records.has(key(x))))
        emit('REFERENCE', r, '', 'Unknown destination');
    }
    if (r.invocation !== null) localStep(s, r.source, null, r.invocation);
    if (!seen.has(id)) emit('UNREACHABLE', r, '', 'Step is unreachable');
    if (s.type === 'agent') {
      if (s.delivery === 'steering') {
        const owner = records.get(key(s.steers))?.step;
        if (
          !owner ||
          owner.type !== 'agent' ||
          owner.delivery === 'steering' ||
          owner.agent !== s.agent ||
          s.decision ||
          own(s, 'next') ||
          id === entry ||
          [...records.values()].some(
            (q) =>
              q.step.type === 'join' &&
              q.step.members.some((x) => key(x) === id),
          )
        )
          emit(
            'STEERING',
            r,
            '',
            'Invalid steering owner or independent continuation',
          );
      } else if (own(s, 'steers'))
        emit(
          'STEERING',
          r,
          'steers',
          'Queued step cannot name a steering owner',
        );
    }
    if (s.type === 'join') {
      if (
        s.mode === 'first'
          ? !own(s, 'accept')
          : own(s, 'accept') || own(s, 'remaining')
      )
        emit('JOIN_POLICY', r, '', 'Join policy fields do not match mode');

      const anchor = records.get(key(s.after));
      let valid =
        !duplicates(s.members) &&
        anchor &&
        Array.isArray(anchor.step.next) &&
        sameSet(anchor.step.next, s.members) &&
        id !== entry;
      if (r.address.length === 1) {
        const authored = top[r.address[0]];
        if (
          top[authored.after]?.type === 'compose' &&
          Object.keys(
            compositions[top[authored.after].composition]?.steps ?? {},
          ).length !== 1
        )
          valid = false;
      }
      for (const m of s.members) {
        const mid = key(m),
          member = records.get(mid);
        if (
          !member ||
          mid === entry ||
          member.step.type === 'join' ||
          (member.step.onError ?? []).length
        )
          valid = false;
        if (
          member &&
          (!routeLists(member.step).length ||
            routeLists(member.step).some(
              ([, xs]) => xs.length !== 1 || key(xs[0]) !== id,
            ))
        )
          valid = false;
        for (const [other, q] of records) {
          if (
            routeLists(q.step).some(([, xs]) =>
              xs.some((x) => key(x) === mid),
            ) &&
            other !== key(s.after)
          )
            valid = false;
          if ((q.step.onError ?? []).some((x) => key(x) === mid)) valid = false;
        }
      }
      for (const [other, q] of records)
        if (
          edges(q.step).some((x) => key(x) === id) &&
          !s.members.some((x) => key(x) === other)
        )
          valid = false;
      if (!valid)
        emit('JOIN_GROUP', r, '', 'Not a bounded direct fork and join');
    }
  }
  approvals(records, entry);
  if (Object.keys(compositions).length)
    report.expandedFlow = {
      entry: address(doc.flow.entry),
      steps: [...records.values()].sort((a, b) =>
        key(a.address) < key(b.address) ? -1 : 1,
      ),
    };

  function approvals(records, entry) {
    const groups = new Map();
    const emit = (r, field, msg) =>
      add('APPROVAL', r.source + (field ? `/${field}` : ''), msg, r.invocation);
    for (const [id, r] of records)
      if (r.step.type === 'approval') {
        const target = key(r.step.call),
          action = records.get(target)?.step;
        if (
          !action ||
          !['agent', 'call'].includes(action.type) ||
          action.delivery === 'steering'
        ) {
          emit(r, '', 'Gate target must be ordinary Agent or Call');
          continue;
        }
        if (!groups.has(target)) groups.set(target, []);
        groups.get(target).push(id);
      }
    for (const [target, gates] of groups) {
      const chainFinding = (_record, _field, message) => {
        for (const gate of gates) emit(records.get(gate), '', message);
      };
      const action = records.get(target);
      if (action && !action.step.scope)
        add(
          'SCOPE',
          action.source,
          'Protected action needs scope',
          action.invocation,
        );
      const successors = new Map(),
        pred = new Map(gates.map((g) => [g, []]));
      for (const g of gates) {
        const r = records.get(g),
          approved = r.step.next.approved;
        if (approved.length !== 1) {
          chainFinding(r, '', 'Gate approval has one target');
          continue;
        }
        const next = key(approved[0]);
        successors.set(g, next);
        if (next !== target && !gates.includes(next)) {
          chainFinding(r, '', 'Gate must approve same chain target');
        }
        if (pred.has(next)) pred.get(next).push(g);
      }
      const firsts = gates.filter((g) => pred.get(g).length === 0);
      if (firsts.length !== 1 || gates.some((g) => pred.get(g).length > 1)) {
        for (const g of gates)
          chainFinding(records.get(g), '', 'Gates must form one finite chain');
        continue;
      }
      const first = firsts[0],
        ordered = [],
        walk = new Set();
      let cur = first;
      while (gates.includes(cur) && !walk.has(cur)) {
        walk.add(cur);
        ordered.push(cur);
        cur = successors.get(cur);
      }
      if (cur !== target || walk.size !== gates.length) {
        for (const g of gates)
          chainFinding(
            records.get(g),
            '',
            'Gate chain does not terminate at action',
          );
        continue;
      }
      const protectedNodes = [...ordered.slice(1), target];
      for (const dest of protectedNodes) {
        const previous =
          dest === target ? ordered.at(-1) : ordered[ordered.indexOf(dest) - 1];
        let bad = dest === entry;
        for (const [id, r] of records) {
          for (const [label, xs] of [
            ...routeLists(r.step),
            ['onError', r.step.onError ?? []],
          ])
            if (
              xs.some((x) => key(x) === dest) &&
              !(id === previous && label === 'next/approved')
            )
              bad = true;
        }
        if (bad)
          chainFinding(
            records.get(previous),
            '',
            'Protected target has bypass incoming edge',
          );
      }
      for (let i = 0; i < ordered.length; i++) {
        const r = records.get(ordered[i]);
        const forbidden = new Set([...ordered.slice(i + 1), target]);
        if (
          [...(r.step.next.denied ?? []), ...(r.step.onError ?? [])].some((x) =>
            [...reach(records, key(x), new Set([first]))].some((n) =>
              forbidden.has(n),
            ),
          )
        )
          chainFinding(
            r,
            '',
            'Denial/error reaches protected work without fresh first gate',
          );
      }
    }
  }
}
function translate(s, targets, address) {
  const out = clone(s);
  if (own(s, 'next'))
    out.next = Array.isArray(s.next)
      ? s.next.flatMap((x) => targets(x, false))
      : Object.fromEntries(
          entries(s.next).map(([k, xs]) => [
            k,
            xs.flatMap((x) => targets(x, false)),
          ]),
        );
  if (own(s, 'onError'))
    out.onError = s.onError.flatMap((x) => targets(x, true));
  for (const f of ['call', 'after', 'steers'])
    if (own(s, f)) out[f] = address(s[f]);
  if (own(s, 'members')) out.members = s.members.map(address);
  return out;
}
