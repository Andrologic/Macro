// Test-only calls to pure exports and captured route evaluator.
import { prepareFlowRoute030 } from '../../src/services/agsdlExecution/prepareFlowRoute030';
import { prepareCall030, commandOutput030, mcpOutput030 } from '../../src/services/agsdlExecution/calls030';
import { capturedContent030 } from '../../src/services/agsdlExecution/contentResolution030';
import { capturedContentForOccurrence030, evaluateCallData030, createHostRoutePort030 } from '../../src/services/agsdlExecution/hostRouteBroker030';
import { ConformanceError } from '../../src/services/agsdlExecution/exact';
export interface RouteDataRequest030 { op: string; json: string }
export async function evaluateRouteData030(request: RouteDataRequest030): Promise<string> {
  try {
    const i = JSON.parse(request.json);
    let output: unknown;
    switch (request.op) {
      case 'prepareCall': output = prepareCall030(i.stepJson, i.source); break;
      case 'command': output = commandOutput030(i.prepared, i.receipt); break;
      case 'mcp': output = mcpOutput030(i.receipt); break;
      case 'callData': output = evaluateCallData030(i); break;
      case 'content': output = capturedContent030(i.identity, i.receipts).resolveSource(i.sourceJson, i.use); break;
      case 'occurrence': {
        const select = capturedContentForOccurrence030(i.cache);
        const selected = select(i.ordinal, i.index, i.target ?? {});
        output = selected?.resolveSource ? selected.resolveSource(i.sourceJson, i.use) : {};
        break;
      }
      case 'route': {
        const { shared, cache, ...input } = i;
        output = prepareFlowRoute030({ ...input,
          ...(shared === undefined ? {} : { content: capturedContent030(shared.identity, shared.receipts) }),
          ...(cache === undefined ? {} : { contentForOccurrence: capturedContentForOccurrence030(cache) }),
        }); break;
      }
      case 'broker': output = await createHostRoutePort030(i.generation ?? 'generation').evaluate(i.job); break;
      default: throw new Error('Unknown route-data operation');
    }
    return JSON.stringify({ status: 'ok', json: JSON.stringify(output) });
  } catch (error) {
    return JSON.stringify(error instanceof ConformanceError
      ? { status: 'failure', code: error.code, pointer: error.pointer, message: error.message }
      : { status: error instanceof RangeError ? 'resourceLimit' : 'exception', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) });
  }
}
