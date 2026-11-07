// SPDX-License-Identifier: Apache-2.0
// Port of AgSDL v0.3.0 tooling/agsdl/schemacheck.py. See LICENSE.
// Implements the published AgSDL keyword subset, not arbitrary JSON Schema.
import { equal, compareNumbers, isNumber, isObject, json_type_matches, stringify, orderedEntries } from './values.mjs';
export { equal as json_equal, isNumber as is_number, isInteger as is_integer,
  json_type_matches } from './values.mjs';

export const pointer = (parts) => parts.map((part) =>
  `/${(isNumber(part) ? stringify(part) : String(part)).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

function best(results) {
  let chosen = [], depth = -1;
  for (const errors of results) {
    let d = -1;
    for (const [at] of errors) d = Math.max(d, at.split('/').length);
    if (d > depth || (d === depth && errors.length < chosen.length)) {
      chosen = errors; depth = d;
    }
  }
  return chosen;
}

export class SchemaChecker {
  constructor(root) { this.root = root; this._patterns = new Map(); }

  check(value) {
    const errors = [];
    // Generator frames suspend at child checks instead of recursing on the JS stack.
    const stack = [this._check(value, this.root, '', errors)];
    while (stack.length) {
      const next = stack[stack.length - 1].next();
      if (next.done) stack.pop();
      else stack.push(this._check(...next.value));
    }
    return errors;
  }

  _resolve(ref) {
    if (ref === '#') return this.root;
    if (!ref.startsWith('#/')) throw new Error(`Unsupported reference ${ref}`);
    let node = this.root;
    for (const encoded of ref.slice(2).split('/')) {
      const part = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!Object.hasOwn(node, part)) throw new Error(`Unresolved reference ${ref}`);
      node = node[part];
    }
    return node;
  }

  _pattern(text) {
    if (!this._patterns.has(text)) {
      // JSON Schema's final $ means absolute end, including after a newline.
      let escapes = 0;
      for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) escapes++;
      const source = text.endsWith('$') && escapes % 2 === 0 ?
        `${text.slice(0, -1)}(?![\\s\\S])` : text;
      this._patterns.set(text, new RegExp(source, 'u'));
    }
    return this._patterns.get(text);
  }

  *_check(value, schema, path, errors) {
    const at = path;
    if (schema === true) return;
    if (schema === false) { errors.push([at, 'no value is allowed here']); return; }
    if (Object.hasOwn(schema, '$ref')) yield [value, this._resolve(schema.$ref), path, errors];
    if (Object.hasOwn(schema, 'type')) {
      const names = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!names.some((name) => json_type_matches(value, name))) {
        errors.push([at, `expected ${names.join(' or ')}`]); return;
      }
    }
    if (Object.hasOwn(schema, 'const') && !equal(value, schema.const))
      errors.push([at, `expected ${stringify(schema.const)}`]);
    if (Object.hasOwn(schema, 'enum') && !schema.enum.some((item) => equal(value, item)))
      errors.push([at, `expected one of ${schema.enum.map(stringify).join(', ')}`]);
    if (typeof value === 'string') {
      if (Object.hasOwn(schema, 'minLength') && compareNumbers([...value].length, schema.minLength) < 0)
        errors.push([at, 'the string is too short']);
      if (Object.hasOwn(schema, 'pattern') && !this._pattern(schema.pattern).test(value)) {
        const shown = schema.pattern.length <= 80 ? schema.pattern : 'the expected syntax';
        errors.push([at, `${stringify(value)} does not match ${shown}`]);
      }
    }
    if (isNumber(value) && Object.hasOwn(schema, 'minimum') && compareNumbers(value, schema.minimum) < 0)
      errors.push([at, `expected at least ${stringify(schema.minimum)}`]);
    if (Array.isArray(value)) {
      if (Object.hasOwn(schema, 'minItems') && compareNumbers(value.length, schema.minItems) < 0)
        errors.push([at, `expected at least ${stringify(schema.minItems)} items`]);
      if (Object.hasOwn(schema, 'maxItems') && compareNumbers(value.length, schema.maxItems) > 0)
        errors.push([at, `expected at most ${stringify(schema.maxItems)} items`]);
      if (schema.uniqueItems) {
        for (let i = 0; i < value.length; i++) {
          for (let j = 0; j < i; j++) {
            if (equal(value[i], value[j])) { errors.push([`${path}/${i}`, 'duplicate item']); break; }
          }
        }
      }
      const prefix = schema.prefixItems || [];
      for (let i = 0; i < value.length; i++) {
        if (i < prefix.length) yield [value[i], prefix[i], `${path}/${i}`, errors];
        else if (Object.hasOwn(schema, 'items')) yield [value[i], schema.items, `${path}/${i}`, errors];
      }
    }
    if (isObject(value)) {
      for (const name of schema.required || []) {
        if (!Object.hasOwn(value, name)) errors.push([at, `missing field ${stringify(name)}`]);
      }
      const properties = schema.properties || {};
      for (const [key, item] of orderedEntries(value)) {
        const child = `${path}${pointer([key])}`;
        if (Object.hasOwn(schema, 'propertyNames')) {
          const probe = [];
          yield [key, schema.propertyNames, child, probe];
          if (probe.length) { errors.push([child, `invalid name ${stringify(key)}`]); continue; }
        }
        if (Object.hasOwn(properties, key)) yield [item, properties[key], child, errors];
        else if (Object.hasOwn(schema, 'additionalProperties')) {
          if (schema.additionalProperties === false) errors.push([child, `unknown field ${stringify(key)}`]);
          else if (schema.additionalProperties !== true) yield [item, schema.additionalProperties, child, errors];
        }
      }
    }
    if (Object.hasOwn(schema, 'not')) {
      const probe = [];
      yield [value, schema.not, path, probe];
      if (!probe.length) errors.push([at, 'this combination of fields is not allowed']);
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      if (!Object.hasOwn(schema, keyword)) continue;
      const results = [];
      for (const option of schema[keyword]) {
        const probe = [];
        yield [value, option, path, probe];
        results.push(probe);
      }
      const passing = results.filter((result) => !result.length).length;
      if (!passing) for (const error of best(results)) errors.push(error);
      else if (keyword === 'oneOf' && passing > 1) errors.push([at, 'the value matches several alternatives']);
    }
  }
}
