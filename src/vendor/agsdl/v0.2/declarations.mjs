// Macro browser port: IPv6 validation replaces the Node-only net module.
import { isIP } from './ip.mjs';
import {
  entries,
  own,
  object,
  equal,
  duplicates,
  satisfies,
  shape,
  schema,
  pointer,
} from './values.mjs';

// RFC 3986 components retain absent versus explicitly empty query/fragment.
export function uriParts(text) {
  if (
    typeof text !== 'string' ||
    /[^\x21-\x7e]|%(?![0-9a-fA-F]{2})|[<>"{}|\\^`]/.test(text)
  )
    throw Error('Invalid ASCII URI');
  const m =
    /^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
      text,
    );
  if (!m) throw Error('Invalid URI');
  const [, scheme, authority, path, query, fragment] = m;
  const atom = "(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2})";
  if (
    !new RegExp(`^(?:${atom}|/)*$`).test(path) ||
    [query, fragment].some(
      (x) => x !== undefined && !new RegExp(`^(?:${atom}|[/?])*$`).test(x),
    )
  )
    throw Error('Invalid URI component');
  if (authority === undefined && !scheme && path.split('/')[0].includes(':'))
    throw Error('Relative first segment contains colon');
  if (authority !== undefined) {
    const auth = authority.split('@');
    if (auth.length > 2) throw Error('Invalid authority');
    if (
      auth.length === 2 &&
      !/^(?:[A-Za-z0-9._~!$&'()*+,;=:-]|%[0-9a-fA-F]{2})*$/.test(auth[0])
    )
      throw Error('Invalid user info');
    const hostport = auth.at(-1);
    if (hostport.startsWith('[')) {
      const a = /^\[([^\]]+)\](?::[0-9]*)?$/.exec(hostport);
      if (
        !a ||
        !(
          isIP(a[1]) === 6 ||
          /^v[0-9a-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/i.test(a[1])
        )
      )
        throw Error('Invalid IP literal');
    } else if (
      !/^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9a-fA-F]{2})*(?::[0-9]*)?$/.test(
        hostport,
      )
    )
      throw Error('Invalid host/port');
  }
  return { scheme, authority, path, query, fragment };
}
export function baseParts(base) {
  const b = uriParts(base);
  if (
    !b.scheme ||
    b.fragment !== undefined ||
    !(b.authority !== undefined || b.path.startsWith('/'))
  )
    throw Error('Base must be absolute and hierarchical without fragment');
  return b;
}
function removeDots(input) {
  let output = '';
  while (input) {
    if (input.startsWith('../')) input = input.slice(3);
    else if (input.startsWith('./')) input = input.slice(2);
    else if (input.startsWith('/./')) input = input.slice(2);
    else if (input === '/.') input = '/';
    else if (input.startsWith('/../')) {
      input = input.slice(3);
      output = output.replace(/\/?[^/]*$/, '');
    } else if (input === '/..') {
      input = '/';
      output = output.replace(/\/?[^/]*$/, '');
    } else if (input === '.' || input === '..') input = '';
    else {
      const end = input.indexOf('/', input[0] === '/' ? 1 : 0);
      if (end < 0) {
        output += input;
        input = '';
      } else {
        output += input.slice(0, end);
        input = input.slice(end);
      }
    }
  }
  return output;
}
export function resolveUri(ref, base) {
  const r = uriParts(ref);
  let t;
  if (r.scheme) t = { ...r, path: removeDots(r.path) };
  else {
    if (base == null) return null;
    const b = baseParts(base);
    t = { scheme: b.scheme, fragment: r.fragment };
    if (r.authority !== undefined)
      Object.assign(t, {
        authority: r.authority,
        path: removeDots(r.path),
        query: r.query,
      });
    else {
      t.authority = b.authority;
      if (!r.path) {
        t.path = b.path;
        t.query = r.query === undefined ? b.query : r.query;
      } else {
        t.path = removeDots(
          r.path.startsWith('/')
            ? r.path
            : (b.authority !== undefined && !b.path
                ? '/'
                : b.path.slice(0, b.path.lastIndexOf('/') + 1)) + r.path,
        );
        t.query = r.query;
      }
    }
  }
  return (
    `${t.scheme}:` +
    (t.authority === undefined ? '' : `//${t.authority}`) +
    t.path +
    (t.query === undefined ? '' : `?${t.query}`) +
    (t.fragment === undefined ? '' : `#${t.fragment}`)
  );
}
export function checkDeclarations(doc, report, add) {
  let sourceBase = doc.baseUri ?? null;
  const need = (path, need) =>
    report.coreNeeds.push({ path, need, status: 'unassessed' });
  const ref = (map, name, path) => {
    if (!own(map, name)) add('REFERENCE', path, `Unknown reference ${name}`);
  };
  function distinct(values, path) {
    if (duplicates(values)) add('DUPLICATE', path, 'Repeated declaration');
  }
  function source(src, path) {
    if (own(src, 'ref')) {
      ref(doc.content, src.ref, pointer(path, 'ref'));
      return;
    }
    if (!own(src, 'uri')) return;
    try {
      const resolved = resolveUri(src.uri, sourceBase);
      report.sources.push({
        path,
        baseUri: sourceBase,
        uri: src.uri,
        resolved,
        status: resolved === null ? 'unresolved' : 'resolved',
      });
      if (resolved === null) report.unassessed.push(path);
    } catch (e) {
      add('URI', path, e.message);
    }
  }
  function message(m, path, prepared = false) {
    (m.prompt ?? []).forEach((v, i) =>
      source(v, pointer(pointer(path, 'prompt'), i)),
    );
    for (const [name, value] of entries(m.resources)) {
      const p = pointer(pointer(path, 'resources'), name);
      if (prepared && own(value, 'select')) continue;
      if (prepared && own(value, 'source')) {
        if (own(value.source, 'value')) {
          if (!shape(value.source.value, schema.$defs.Source))
            add('SOURCE', p, 'Literal source selector must supply a Source');
          else
            source(value.source.value, pointer(pointer(p, 'source'), 'value'));
        }
      } else source(value, p);
    }
  }
  function constraint(c, p) {
    if (
      c.required &&
      (duplicates(c.required) || c.required.some((k) => !own(c.properties, k)))
    )
      add(
        'VALUE_SCHEMA',
        pointer(p, 'required'),
        'Required properties must be distinct and declared',
      );
    (c.enum ?? []).forEach((v, i, a) => {
      if (a.slice(0, i).some((x) => equal(x, v)) || !satisfies(v, c, true))
        add(
          'VALUE_SCHEMA',
          pointer(pointer(p, 'enum'), i),
          'Enumeration values must be distinct and satisfy constraints',
        );
    });
    if (c.items) constraint(c.items, pointer(p, 'items'));
    for (const [k, v] of entries(c.properties))
      constraint(v, pointer(pointer(p, 'properties'), k));
  }
  function claims(decl, p) {
    (decl.requires ?? []).forEach((v, i, a) => {
      if (a.slice(0, i).some((x) => equal(x, v)))
        add(
          'DUPLICATE',
          pointer(pointer(p, 'requires'), i),
          'Repeated requirement',
        );
    });
    (decl.claims ?? []).forEach((v, i, a) => {
      if (a.slice(0, i).some((x) => equal(x.requirement, v.requirement)))
        add(
          'CLAIM',
          pointer(pointer(p, 'claims'), i),
          'Claims repeat an exact requirement',
        );
    });
  }
  function assessment(decl, requirements, p, extra = {}) {
    const reqs = requirements;
    const assessed = reqs.map((requirement) => {
      const cs = (decl.claims ?? []).filter((c) =>
        equal(c.requirement, requirement),
      );
      const c = cs[0];
      return {
        requirement,
        status:
          c?.status === 'unsupported'
            ? 'incompatible'
            : c?.status === 'supported' && c.evidence
              ? 'declared-supported'
              : 'unknown',
      };
    });
    const statuses = assessed.map((x) => x.status);
    const status = !assessed.length
      ? 'not-requested'
      : statuses.includes('incompatible')
        ? 'incompatible'
        : statuses.includes('unknown')
          ? 'unknown'
          : 'declared-supported';
    report.support.push({ path: p, ...extra, status, requirements: assessed });
  }
  if (own(doc, 'baseUri'))
    try {
      baseParts(doc.baseUri);
    } catch (e) {
      add('URI', '/baseUri', e.message);
      sourceBase = null;
    }
  for (const [k, v] of entries(doc.content)) source(v, pointer('/content', k));
  for (const [k, v] of entries(doc.skills)) {
    const p = pointer('/skills', k);
    message(v, p);
    claims(v, p);
  }
  for (const [k, v] of entries(doc.bindings)) {
    const p = pointer('/bindings', k);
    claims(v, p);
    assessment(v, v.requires ?? [], p);
  }
  for (const [k, v] of entries(doc.configurations)) {
    const p = pointer('/configurations', k);
    ref(doc.bindings, v.engine, pointer(p, 'engine'));
    for (const [n, t] of entries(v.tools))
      ref(doc.bindings, t, pointer(pointer(p, 'tools'), n));
    claims(v, p);
  }
  for (const [k, a] of entries(doc.agents)) {
    const p = pointer('/agents', k);
    message(a, p);
    need(p, 'agent-continuity-and-initialization');
    need(p, 'content-role-and-media-delivery');
    distinct(a.skills ?? [], pointer(p, 'skills'));
    const used = new Set();
    for (const s of a.skills ?? []) {
      ref(doc.skills, s, pointer(p, 'skills'));
      for (const name of Object.keys(doc.skills?.[s]?.resources ?? {})) {
        if (used.has(name))
          add(
            'RESOURCE_COLLISION',
            pointer(p, 'skills'),
            'Skill resource collision',
          );
        used.add(name);
      }
    }
    for (const name of Object.keys(a.resources ?? {}))
      if (used.has(name))
        add(
          'RESOURCE_COLLISION',
          pointer(p, 'skills'),
          'Agent resource collision',
        );
    const choices =
      typeof a.configuration === 'string'
        ? [[null, a.configuration]]
        : entries(a.configuration.cases);
    if (typeof a.configuration !== 'string')
      need(pointer(p, 'configuration'), 'retained-configuration-selection');
    const assessedConfigurations = new Set();
    for (const [label, configuration] of choices) {
      const loc =
        label === null
          ? pointer(p, 'configuration')
          : pointer(pointer(pointer(p, 'configuration'), 'cases'), label);
      ref(doc.configurations, configuration, loc);
      if (
        own(doc.configurations, configuration) &&
        !assessedConfigurations.has(configuration)
      ) {
        assessedConfigurations.add(configuration);
        const c = doc.configurations[configuration];
        const req = [...(c.requires ?? [])];
        for (const r of (a.skills ?? []).flatMap(
          (s) => doc.skills?.[s]?.requires ?? [],
        ))
          if (!req.some((x) => equal(x, r))) req.push(r);
        assessment(c, req, p, {
          configuration,
          selection: label === null ? 'fixed' : 'conditional',
        });
      }
    }
    const it = a.interface ?? {};
    for (const f of ['inputMediaTypes', 'outputMediaTypes'])
      if (own(it, f))
        need(pointer(pointer(p, 'interface'), f), 'combined-media-path');
    for (const [n, r] of entries(it.results)) {
      const rp = pointer(pointer(pointer(p, 'interface'), 'results'), n);
      need(rp, 'required-result-delivery');
      if (
        it.outputMediaTypes &&
        r.mediaTypes.some((v) => !it.outputMediaTypes.includes(v))
      )
        add('OUTPUT_FORMAT', rp, 'Result formats exceed Interface formats');
      if (r.valueSchema) {
        constraint(r.valueSchema, pointer(rp, 'valueSchema'));
        need(pointer(rp, 'valueSchema'), 'structured-result-check');
      }
    }
  }
  function steps(map, p) {
    for (const [k, s] of entries(map)) {
      const sp = pointer(p, k);
      if (s.type === 'prepare')
        message(s.message, pointer(sp, 'message'), true);
      if (s.type === 'agent')
        need(sp, s.delivery === 'steering' ? 'steering' : 'queued-delivery');
      if (s.type === 'call') need(sp, 'external-call-contract');
      if (s.type === 'join') need(sp, 'group-correlation-and-stopping');
      if (s.type === 'approval') need(sp, 'actual-invocation-approval');
      if (s.type === 'compose') need(sp, 'composition-expansion');
    }
  }
  steps(doc.flow?.steps, '/flow/steps');
  for (const [k, c] of entries(doc.compositions))
    steps(c.steps, pointer(pointer('/compositions', k), 'steps'));
}
