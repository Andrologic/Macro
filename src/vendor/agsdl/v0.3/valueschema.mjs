// SPDX-License-Identifier: Apache-2.0
// Port of AgSDL v0.3.0 tooling/agsdl/valueschema.py. See LICENSE.
import { equal, compareNumbers, isInteger, json_type_matches, stringify, orderedEntries } from './values.mjs';
import { pointer } from './schemacheck.mjs';

const ARRAY_ONLY = ['items', 'minItems', 'maxItems'];
const OBJECT_ONLY = ['properties', 'required', 'additionalProperties'];
export const is_index = isInteger;

export function consistency(schema, path = []) {
  const problems = [], pending = [[schema, path]];
  while (pending.length) {
    const [node, here, childrenDone] = pending.pop(), kind = node.type;
    if (childrenDone) {
      const minimum = node.minItems ?? 0;
      if (compareNumbers(minimum, node.maxItems ?? minimum) > 0)
        problems.push([pointer([...here, 'minItems']), 'minItems exceeds maxItems']);
      if (kind === 'array' && Object.hasOwn(node, 'items')) pending.push([node.items, [...here, 'items']]);
      continue;
    }
    // The reference checks object children before bounds, then array items.
    pending.push([node, here, true]);
    for (const key of ARRAY_ONLY) {
      if (Object.hasOwn(node, key) && kind !== 'array')
        problems.push([pointer([...here, key]), `${key} is allowed only on arrays`]);
    }
    for (const key of OBJECT_ONLY) {
      if (Object.hasOwn(node, key) && kind !== 'object')
        problems.push([pointer([...here, key]), `${key} is allowed only on objects`]);
    }
    if (Object.hasOwn(node, 'enum')) {
      for (let i = 0; i < node.enum.length; i++) {
        const value = node.enum[i], at = pointer([...here, 'enum', i]);
        if (!json_type_matches(value, kind)) problems.push([at, `enum value is not of type ${kind}`]);
        if (node.enum.slice(0, i).some((earlier) => equal(value, earlier))) problems.push([at, 'duplicate enum value']);
      }
    }
    if (kind === 'object') {
      const declared = node.properties || {};
      for (const [i, name] of (node.required || []).entries()) {
        if (!Object.hasOwn(declared, name))
          problems.push([pointer([...here, 'required', i]), `${stringify(name)} is not a declared property`]);
      }
      for (const [name, child] of orderedEntries(declared).reverse())
        pending.push([child, [...here, 'properties', name]]);
    }
  }
  return problems;
}

export function validate(value, schema, path = []) {
  const problems = [], pending = [[value, schema, path]];
  while (pending.length) {
    const [item, node, here, message] = pending.pop(), at = pointer(here);
    if (message) { problems.push([at, message]); continue; }
    const kind = node.type;
    if (!json_type_matches(item, kind)) { problems.push([at, `expected ${kind}`]); continue; }
    if (Object.hasOwn(node, 'enum') && !node.enum.some((allowed) => equal(item, allowed)))
      problems.push([at, `expected one of ${node.enum.map(stringify).join(', ')}`]);
    if (kind === 'array') {
      for (const [key, comparison, qualifier] of [['minItems', -1, 'least'], ['maxItems', 1, 'most']]) {
        if (Object.hasOwn(node, key) && compareNumbers(item.length, node[key]) === comparison)
          problems.push([at, `expected at ${qualifier} ${stringify(node[key])} item${equal(node[key], 1) ? '' : 's'}`]);
      }
      if (Object.hasOwn(node, 'items')) {
        for (let i = item.length - 1; i >= 0; i--) pending.push([item[i], node.items, [...here, i]]);
      }
    }
    if (kind === 'object') {
      const declared = node.properties || {};
      for (const name of node.required || []) {
        if (!Object.hasOwn(item, name)) problems.push([at, `missing ${stringify(name)}`]);
      }
      // Schedule unknown fields too, preserving the published traversal order.
      for (const [name, child] of orderedEntries(item).reverse()) {
        if (Object.hasOwn(declared, name)) pending.push([child, declared[name], [...here, name]]);
        else if (node.additionalProperties === false)
          pending.push([child, null, [...here, name], `unknown ${stringify(name)}`]);
      }
    }
  }
  return problems;
}

export function descend(schema, path) {
  let node = schema;
  for (const part of path) {
    if (node == null) return [null, null];
    const kind = node.type;
    if (kind === 'object' && typeof part === 'string') {
      const declared = node.properties || {};
      if (!Object.hasOwn(declared, part)) return node.additionalProperties === false ?
        [false, `${stringify(part)} is not a declared property`] : [null, null];
      node = declared[part];
    } else if (kind === 'array' && is_index(part)) {
      if (Object.hasOwn(node, 'maxItems') && compareNumbers(part, node.maxItems) >= 0)
        return [false, `index ${stringify(part)} is beyond the ${stringify(node.maxItems)} items the list may have`];
      node = node.items;
    } else return [false, `cannot select ${stringify(part)} in a value of type ${kind}`];
  }
  return [true, null];
}

export function kind_at(schema, path) {
  let node = schema;
  for (const part of path) {
    if (node == null || !Object.hasOwn(node, 'type')) return null;
    if (node.type === 'object' && typeof part === 'string') {
      const properties = node.properties || {};
      node = Object.hasOwn(properties, part) ? properties[part] : undefined;
    } else if (node.type === 'array' && is_index(part)) node = node.items;
    else return null;
  }
  return node?.type ?? null;
}
