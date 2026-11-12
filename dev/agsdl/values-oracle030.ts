// Test-only oracle for D15 2.c.1. Call the shipped TS helpers, never a second
// implementation. Exact values cross JSON-lines as text or hexadecimal bytes.
// @ts-expect-error Historical scanner has no declaration file; its test-only contract is typed below.
import * as sharedScanner from '../../src/vendor/agsdl/shared/json.mjs';
import * as sharedValues from '../../src/vendor/agsdl/shared/values.mjs';
// @ts-expect-error Historical scanner has no declaration file; its test-only contract is typed below.
import * as experimentalScanner from '../../src/vendor/agsdl/experimental/readers/javascript/json.mjs';
import * as v030 from '../../src/vendor/agsdl/v0.3/json.mjs';
import * as values from '../../src/vendor/agsdl/v0.3/values.mjs';
import * as schemas from '../../src/vendor/agsdl/v0.3/valueschema.mjs';
import { SchemaChecker } from '../../src/vendor/agsdl/v0.3/schemacheck.mjs';
import documentSchema from '../../src/vendor/agsdl/v0.3/schema/agsdl.schema.json';
import * as exact from '../../src/services/agsdlExecution/exact';
import type { ExactJsonText } from '../../src/services/agsdlExecution/contracts';
import * as integers from '../../src/services/agsdlExecution/workIntegers030';
import { connectValueSchemaValidator030 } from '../../src/services/agsdlExecution/valueSchemaPort030';

type Mode = 'shared' | 'experimental' | 'v030';
type Part = { kind: 'key'; raw: string } | { kind: 'number'; raw: string } | { kind: 'index'; index: number };
export type ValuesRequest030 =
  | { op: 'parse'; mode: Mode; hex: string; clone?: boolean }
  | { op: 'values'; left: string; right: string }
  | { op: 'schema'; schema: string; value: string; path: Part[]; pointer: string }
  | { op: 'access'; action: 'record' | 'list' | 'text' | 'has' | 'at'; value: string; pointer: string; key: string; missing?: boolean }
  | { op: 'integer'; action: 'integer' | 'compare' | 'monotone' | 'bounded' | 'timer'; raw: string; other: string; positive: boolean; slice: number; noLimit: boolean }
  | { op: 'probe'; mode: Mode; depth: number };

type Scanner = Pick<typeof v030, 'parse' | 'stringify' | 'ParseError'>;
const shared = sharedScanner as Scanner & { uint(value: unknown, positive?: boolean): boolean };
const experimental = experimentalScanner as Scanner;
const scanner = (mode: Mode): Scanner => mode === 'shared' ? shared : mode === 'experimental' ? experimental : v030;
const shape = new SchemaChecker({ $ref: '#/$defs/valueSchema', $defs: documentSchema.$defs });
const port = connectValueSchemaValidator030({ NumberToken: v030.NumberToken, parse: v030.parse, validate: schemas.validate });

function read(text: string) {
  const parsed = v030.parse(new TextEncoder().encode(text));
  if (parsed.error) throw parsed.error;
  return parsed.tree;
}

function evaluate(request: ValuesRequest030): unknown {
  switch (request.op) {
    case 'parse': {
      const bytes = Uint8Array.from(Buffer.from(request.hex, 'hex'));
      const api = scanner(request.mode), parsed = api.parse(bytes);
      bytes.fill(0); // The scanner must own its returned bytes.
      const bytesHex = Buffer.from(parsed.bytes).toString('hex');
      if (parsed.error) return { status: 'parseError', byte: parsed.error.byte, message: parsed.error.message,
        tree: parsed.tree, spans: [...parsed.spans], bytesHex };
      return { status: 'ok', output: { encoded: api.stringify(parsed.tree),
        // The experimental scanner has its own token class and no clone API.
        // Feeding its AST to shared.clone is not an actual supported call path.
        cloned: request.clone === false || request.mode === 'experimental' ? null : shared.stringify(sharedValues.clone(parsed.tree)), spans: [...parsed.spans], bytesHex } };
    }
    case 'values': {
      const left = exact.decode(request.left), right = exact.decode(request.right);
      const decimal = (value: exact.ExactValue) => {
        if (!(value instanceof exact.NumberToken)) return null;
        const [sign, digits, exponent] = exact.decimal(value);
        return [sign, digits, exponent.toString()];
      };
      return { equal: exact.equal(left, right), equal030: values.equal(left, right),
        equalText: exact.exactValues.equal(request.left as ExactJsonText, request.right as ExactJsonText),
        left: exact.encode(left), right: exact.encode(right), decimal: decimal(left),
        compare: values.isNumber(left) && values.isNumber(right) ? values.compareNumbers(left, right) : null,
        integer: sharedValues.integer(left), integer030: values.isInteger(left),
        uint: shared.uint(left), positiveUint: shared.uint(left, true),
        types: ['null', 'boolean', 'number', 'integer', 'string', 'array', 'object', 'unknown']
          .map(kind => values.json_type_matches(left, kind)) };
    }
    case 'schema': {
      const schema = read(request.schema);
      // Classify the helper's published precondition using the actual schema
      // checker. Outside-shape probes do not claim helper semantic equivalence.
      if (shape.check(schema).length) return { inDomain: false };
      const value = read(request.value);
      const path = request.path.map(part => part.kind === 'key' ? part.raw : part.kind === 'number' ? new v030.NumberToken(part.raw) : part.index);
      return { inDomain: true, consistency: schemas.consistency(schema, path),
        validate: schemas.validate(value, schema, path), descend: schemas.descend(schema, path),
        kindAt: schemas.kind_at(schema, path), port: port(value, schema, request.pointer) };
    }
    case 'access': {
      if (request.action === 'at') return exact.at(request.pointer, request.key);
      const value = request.missing ? undefined : exact.decode(request.value);
      switch (request.action) {
        case 'record': return exact.encode(exact.record(value, request.pointer));
        case 'list': return exact.encode(exact.list(value, request.pointer));
        case 'text': return exact.text(value, request.pointer);
        case 'has': return exact.has(exact.record(value, request.pointer), request.key);
      }
      break;
    }
    case 'integer':
      switch (request.action) {
        case 'integer': return integers.integer030(request.raw, request.positive);
        case 'compare': return integers.compareIntegers030(request.raw, request.other);
        case 'monotone': return integers.monotoneMs030(request.raw).toString();
        case 'bounded': return integers.boundedInteger030(request.raw, BigInt(request.other)).toString();
        case 'timer': return integers.timerDelay030(request.noLimit ? null : request.raw, BigInt(request.other), request.slice);
      }
      break;
    case 'probe': {
      const source = '['.repeat(request.depth) + '0' + ']'.repeat(request.depth);
      const parsed = scanner(request.mode).parse(new TextEncoder().encode(source));
      if (parsed.error) throw parsed.error;
      return { depth: request.depth, bytes: parsed.bytes.length };
    }
  }
}

export function evaluateValues030(request: ValuesRequest030): unknown {
  try {
    const output = evaluate(request);
    if (request.op === 'parse') return output;
    return { status: 'ok', output };
  } catch (error) {
    if (error instanceof exact.ConformanceError)
      return { status: 'failure', code: error.code, pointer: error.pointer, message: error.message };
    if (error instanceof shared.ParseError || error instanceof experimental.ParseError)
      return { status: 'parseError', byte: error.byte, message: error.message };
    // Never turn JS stack exhaustion into an AgSDL parse rejection or a match.
    if (error instanceof RangeError)
      return { status: 'resourceLimit', name: error.name, message: error.message };
    throw error;
  }
}
