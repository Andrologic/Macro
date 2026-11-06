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

export function read(bytes, options) {
  const parsed = parse(bytes);
  if (parsed.error) {
    const report = new Report();
    report.error('PARSE', '', parsed.error.message);
    return report.as_json();
  }
  return validateExact(parsed.tree, options);
}

export function validateExact(document, options) {
  return validate_document(document, registry(options)).as_json();
}
