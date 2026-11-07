// SPDX-License-Identifier: Apache-2.0
// Browser entry points for AgSDL 0.3.0. Based on tooling/agsdl/validator.py.
// Upstream Andrologic/AgSDL bd9f8a5b16923476fd20ac2650bd1729ee151917.
import { parse, stringify } from './json.mjs';
import { ModuleError, Report, check_module, validate_document } from './validator.mjs';
import claudeCode from './harnesses/claude-code/module.json' with { type: 'json' };
import codex from './harnesses/codex/module.json' with { type: 'json' };
import opencode from './harnesses/opencode/module.json' with { type: 'json' };
import pi from './harnesses/pi/module.json' with { type: 'json' };

export { parse, stringify, NumberToken } from './json.mjs';
export { equal, compareNumbers, isInteger } from './values.mjs';
export { ModuleError } from './validator.mjs';

export function loadHarnessModule(bytes) {
  const parsed = parse(bytes);
  if (parsed.error) throw new ModuleError(parsed.error.message);
  return check_module(parsed.tree);
}

function copyModule(module) {
  try {
    // Reparse exact serialization to detach every object, list and numeric token.
    return loadHarnessModule(new TextEncoder().encode(stringify(module)));
  } catch (error) {
    if (error instanceof ModuleError) throw error;
    throw new ModuleError(error instanceof Error ? error.message : String(error));
  }
}

// These pinned JSON imports contain no numeric literals. Custom module numbers
// enter through loadHarnessModule and retain their original NumberToken lexemes.
const defaults = [claudeCode, codex, opencode, pi].map(copyModule);
function registry(options) {
  const source = options?.modules === undefined ? defaults.map((module) => [module.name, module]) : options.modules;
  const modules = new Map();
  if (source == null || typeof source[Symbol.iterator] !== 'function') throw new ModuleError('modules must be a ReadonlyMap');
  for (const [name, value] of source) {
    const module = copyModule(value);
    if (name !== module.name) throw new ModuleError(`module registry key '${name}' does not match name '${module.name}'`);
    modules.set(name, module);
  }
  return modules;
}

export function readWithSpans(bytes, options) {
  const parsed = parse(bytes);
  if (parsed.error) {
    const report = new Report();
    report.error('PARSE', '', parsed.error.message);
    return { report: report.as_json(), spans: parsed.spans };
  }
  return { report: validate_document(parsed.tree, registry(options)).as_json(), spans: parsed.spans };
}

export function read(bytes, options) {
  return readWithSpans(bytes, options).report;
}

export function validateExact(document, options) {
  // Snapshot only after the module registry is detached. This also makes a
  // mutable caller-provided tree obey the same JSON boundary as read(bytes).
  const modules = registry(options);
  let source;
  try { source = stringify(document); }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const report = new Report();
    report.error('PARSE', '', error.message);
    return report.as_json();
  }
  const parsed = parse(new TextEncoder().encode(source));
  if (parsed.error) {
    const report = new Report();
    report.error('PARSE', '', parsed.error.message);
    return report.as_json();
  }
  return validate_document(parsed.tree, modules).as_json();
}
