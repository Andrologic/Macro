// JSON-lines transport for the native, in-process conformance test. Evaluators
// are the resident host's ports; stdout is reserved for correlated replies.
import { createInterface } from 'node:readline';
import { compileHost030 } from '../../src/services/agsdlExecution/hostCompilation';
import { createHostWorkPort030 } from '../../src/services/agsdlExecution/hostWorkPort030';
import { createHostRoutePort030 } from '../../src/services/agsdlExecution/hostRouteBroker030';
import { connectValueSchemaValidator030 } from '../../src/services/agsdlExecution/valueSchemaPort030';
import { NumberToken, parse } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { validate } from '../../src/vendor/agsdl/v0.3/valueschema.mjs';
import type { HostRouteJob030, HostWorkJob030 } from '../../src/types/generated/ipc';
import type { CapturedRegistry030 } from '../../src/services/agsdlExecution/contracts030';
import type { SourceRevision } from '../../src/services/agsdlExecution/contracts';
import { evaluateValues030, type ValuesRequest030 } from './values-oracle030';
import { evaluateReader030, type ReaderRequest030 } from './reader-oracle030';
import { evaluateRoutes030, type RoutesRequest030 } from './routes-oracle030';
import { evaluateNativeJson030, type NativeJsonRequest030 } from './native-json-oracle030';
import { evaluateCompile030, type CompileRequest030 } from './compile-oracle030';
import { buildCompileCorpus030 } from './compile-corpus030';

type Request = { id: number } & (
  | { kind: 'compile'; authoredSource: string; source: SourceRevision; registry: CapturedRegistry030 }
  | { kind: 'work'; job: HostWorkJob030 }
  | { kind: 'route'; job: HostRouteJob030 }
  | { kind: 'values'; request: ValuesRequest030 }
  | { kind: 'reader'; request: ReaderRequest030 }
  | { kind: 'routes'; request: RoutesRequest030 }
  | { kind: 'nativeJson'; request: NativeJsonRequest030 }
  | { kind: 'compilePure'; request: CompileRequest030 }
  | { kind: 'compileCorpus'; request: null }
);
const validator = connectValueSchemaValidator030({ NumberToken, parse, validate });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let id: number | null = null;
  try {
    const request = JSON.parse(line) as Request;
    id = request.id;
    let output: unknown;
    switch (request.kind) {
      case 'compile': output = JSON.parse(await compileHost030(request.authoredSource, request.source, request.registry)); break;
      case 'work': output = await createHostWorkPort030(request.job.generation, validator).evaluate(request.job); break;
      case 'route': output = await createHostRoutePort030(request.job.generation).evaluate(request.job); break;
      case 'values': output = evaluateValues030(request.request); break;
      case 'reader': output = evaluateReader030(request.request); break;
      case 'routes': output = evaluateRoutes030(request.request); break;
      case 'nativeJson': output = { json: JSON.stringify(evaluateNativeJson030(request.request)) }; break;
      case 'compilePure': output = { json: await evaluateCompile030(request.request) }; break;
      case 'compileCorpus': output = await buildCompileCorpus030(); break;
      default: throw new Error('Unknown conformance host operation');
    }
    process.stdout.write(JSON.stringify({ id, output }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: String(error) }) + '\n');
  }
}
