// Test-only direct calls to the shipped routes/messages exports. Result envelopes
// are exact JSON text; lexical message strings and DTO property order survive.
import { ConformanceError, decode, encode } from '../../src/services/agsdlExecution/exact';
import { instructionsExpectation030, normalizeRoute030, preflightExpansion030, type Scope030, type RouteSource030, type RouteTarget030, type ItemContext030, type ResultMetadata030 } from '../../src/services/agsdlExecution/routes030';
import { instructionAuthority030, readPath030, resolveRouteMessage030, selectValue030 } from '../../src/services/agsdlExecution/messages030';
import type { ExactJsonText } from '../../src/services/agsdlExecution/contracts';
export interface RoutesRequest030 {
  op: 'normalize' | 'expand' | 'expect' | 'path' | 'select' | 'authority' | 'message' | 'construct';
  route?: string; agent?: string; scopes?: { prefix?: string[]; steps: Scope030['steps']; outputs?: string[]; outputRoutes?: [string,{ routeJson: ExactJsonText; scope: number }][] }[];
  scope?: number | null; source?: RouteSource030; item?: ItemContext030; target?: RouteTarget030;
  document?: string; value?: string; path?: string; metadata?: ResultMetadata030[];
  content?: { deferPromptUris?: boolean; entries?: { sourceJson: string; capturedJson: string }[] };
  entries?: [string,string][]; updates?: [string,string][];
}
const j = (text: string) => text as ExactJsonText;
function scopes(request: RoutesRequest030): Scope030[] {
  const all = (request.scopes ?? []).map(({ outputRoutes: _routes, ...scope }) => scope as Scope030);
  for (const [index, spec] of (request.scopes ?? []).entries()) if (spec.outputRoutes !== undefined) {
    (all[index] as { outputRoutes: Scope030['outputRoutes'] }).outputRoutes = Object.fromEntries(spec.outputRoutes.map(([name, continuation]) => [name, { routeJson: continuation.routeJson, scope: all[continuation.scope] }]));
  }
  return all;
}
export function evaluateRoutes030(request: RoutesRequest030): unknown {
  const calls: unknown[] = [];
  try {
    const all = scopes(request);
    const scope = request.scope === null ? undefined : all[request.scope ?? 0];
    const targets = () => normalizeRoute030(j(request.route!), scope!);
    let result: unknown;
    switch (request.op) {
      case 'normalize': result = targets(); break;
      case 'expand': result = preflightExpansion030(targets(), request.source!); break;
      case 'expect': result = instructionsExpectation030(j(request.agent!), j(request.route!), scope!); break;
      case 'path': result = encode(readPath030(decode(request.value!), decode(request.path!))); break;
      case 'select': result = selectValue030(j(request.value!), j(request.path!), request.item!, request.metadata); break;
      case 'authority': result = instructionAuthority030(request.source!, j(request.path!)) ?? null; break;
      case 'message': result = resolveRouteMessage030(j(request.document!), request.target ?? targets()[0], request.source!, request.item!, {
        ...(request.content?.deferPromptUris === undefined ? {} : { deferPromptUris: request.content.deferPromptUris }),
        ...(request.content?.entries === undefined ? {} : { resolveSource: (raw: ExactJsonText, context: { usage: 'prompt' | 'resource'; pointer: string }) => {
          calls.push([raw, context]);
          const entry = request.content!.entries!.find(entry => entry.sourceJson === raw);
          if (!entry) throw new ConformanceError('CONTENT_UNAVAILABLE', context.pointer, 'No matching captured source.');
          return j(entry.capturedJson);
        } }),
      }); break;
      case 'construct': {
        const object = Object.fromEntries(request.entries!.map(([key, raw]) => [key, decode(raw)]));
        for (const [key, raw] of request.updates ?? []) Object.defineProperty(object, key, { value: decode(raw), enumerable: true, writable: true, configurable: true });
        result = encode(object); break;
      }
    }
    return { status: 'ok', json: JSON.stringify(result), callsJson: JSON.stringify(calls) };
  } catch (error) {
    if (error instanceof ConformanceError) return { status: 'failure', code: error.code, pointer: error.pointer, message: error.message, callsJson: JSON.stringify(calls) };
    return { status: error instanceof RangeError ? 'resourceLimit' : 'exception', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error), callsJson: JSON.stringify(calls) };
  }
}
