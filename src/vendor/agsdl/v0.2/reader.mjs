// Macro browser port: CLI file I/O is omitted. Static checks are unchanged.
import { parse, stringify, shape } from './values.mjs';
import { checkDeclarations } from './declarations.mjs';
import { checkGraphs } from './graphs.mjs';
export function read(bytes) {
  const report = {
    contract: 'agsdl-0.2.0',
    valid: false,
    scope: 'document-shape-and-declared-references',
    executionSupport: 'not-assessed',
    findings: [],
  };
  const add = (code, path, message, invocation = null) => {
    const f = { code, path };
    if (invocation !== null) f.invocation = invocation;
    if (
      !report.findings.some(
        (x) =>
          x.code === code && x.path === path && x.invocation === f.invocation,
      )
    )
      report.findings.push(f);
  };
  let parsed;
  try {
    parsed = parse(bytes);
  } catch (e) {
    report.scope = 'parse';
    add('PARSE', '', `Unsupported parser limit: ${e.message}`);
    return report;
  }
  if (parsed.error) {
    report.scope = 'parse';
    add('PARSE', '', parsed.error.message);
    return report;
  }
  try {
    if (!shape(parsed.tree)) {
      add('SHAPE', '', 'Document does not match closed candidate schema');
      return report;
    }
  } catch (e) {
    report.scope = 'parse';
    add('PARSE', '', `Unsupported shape depth: ${e.message}`);
    return report;
  }
  Object.assign(report, {
    sources: [],
    support: [],
    coreNeeds: [],
    unassessed: [],
  });
  checkDeclarations(parsed.tree, report, add);
  checkGraphs(parsed.tree, report, add);
  report.valid = report.findings.length === 0;
  return report;
}
