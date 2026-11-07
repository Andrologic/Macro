import { NumberToken, encode, fail } from './exact';
import type { ValueSchemaValidator030 } from './agentWorkContracts030';

/** Direct adapter for reader01's valueschema.mjs. A scanner bridge transports
 * exact JSON text only when the historical and 030 scanner classes differ. */
export function connectValueSchemaValidator030(reader: {
  readonly NumberToken: typeof NumberToken;
  readonly parse?: (bytes: Uint8Array) => { readonly tree: unknown; readonly error?: unknown };
  readonly validate: (value: unknown, schema: unknown, path: readonly string[]) => readonly (readonly [string, string])[];
}): ValueSchemaValidator030 {
  const parse = reader.parse;
  if (reader.NumberToken !== NumberToken && !parse) fail('HARNESS_REFUSED', '/valueSchema', 'Different scanner classes require the reader030 exact parse bridge.');
  const adapt = (value: Parameters<ValueSchemaValidator030>[0]): unknown => {
    if (reader.NumberToken === NumberToken) return value;
    // No numeric conversion or second schema semantics: use reader01's scanner
    // on the lexemes emitted by the existing exact serializer.
    const parsed = parse!(new TextEncoder().encode(encode(value)));
    if (parsed.error) fail('CORRELATION', '/valueSchema', 'Reader030 rejected an exact JSON value.');
    return parsed.tree;
  };
  return (value, schema, pointer) => reader.validate(adapt(value), adapt(schema), pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')))
    .map(([path, message]) => ({ pointer: path, rule: 'VALUE_SCHEMA', message }));
}
