import { NumberToken, fail, type ExactValue } from './exact';
import type { ValueSchemaValidator030 } from './agentWorkContracts030';

/** Direct adapter for reader01's valueschema.mjs validate(value,schema,path).
 * The injected module must share exact.ts's scanner class. No 0.2 fallback. */
export function connectValueSchemaValidator030(reader: {
  readonly NumberToken: typeof NumberToken;
  readonly validate: (value: ExactValue, schema: ExactValue, path: readonly string[]) => readonly (readonly [string, string])[];
}): ValueSchemaValidator030 {
  if (reader.NumberToken !== NumberToken) fail('HARNESS_REFUSED', '/valueSchema', 'Reader030 and exact.ts must share their NumberToken scanner class.');
  return (value, schema, pointer) => reader.validate(value, schema, pointer === '' ? [] : pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')))
    .map(([path, message]) => ({ pointer: path, rule: 'VALUE_SCHEMA', message }));
}
