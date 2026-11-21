// Test-only calls to the actual compilation, capture and contract exports. The
// payload and outputs stay JSON text, including native escaped UTF-16 units.
import { compilePlan030 } from '../../src/services/agsdlExecution/compiler030';
import { compileStaticGraph030 } from '../../src/services/agsdlExecution/compilerGraph030';
import { captureAgent030, captureRegistry030, usedProperties030 } from '../../src/services/agsdlExecution/configuration030';
import { compileHost030, encodeHostCompilation } from '../../src/services/agsdlExecution/hostCompilation';
import { createAgentWorkContract030, copyContract030 } from '../../src/services/agsdlExecution/agentWorkContracts030';
import { captureSourceRevision, captureNativeJson, metadataObject, metadataText, metadataIdentity, metadataArray, metadataJson } from '../../src/services/agsdlExecution/metadata';
import { readExactDocument } from '../../src/services/agsdl/document';
import { ConformanceError, decode, encode, record, type ExactObject } from '../../src/services/agsdlExecution/exact';
export interface CompileRequest030 {
    op: 'host' | 'plan' | 'snapshot' | 'graph' | 'registry' | 'agent' | 'used' | 'contract' | 'copyContract' | 'source' | 'nativeCapture' | 'metadata' | 'encodeHost' | 'read' | 'addressOrder';
    json: string;
}
export async function evaluateCompile030(request: CompileRequest030): Promise<string> {
    try {
        const input = JSON.parse(request.json);
        let value: unknown;
        switch (request.op) {
            case 'host': return JSON.stringify({ status: 'ok', json: await compileHost030(input.authored, input.source, input.registry) });
            case 'plan':
                value = await compilePlan030(input.authored, input.source, input.registry);
                break;
            case 'snapshot': {
                const pending = compilePlan030(input.authored, input.source, input.registry);
                Object.assign(input.source.owner, input.mutateSourceOwner ?? {});
                if (input.registry.agents[0])
                    Object.assign(input.registry.agents[0], input.mutateAgent ?? {});
                value = await pending;
                break;
            }
            case 'graph':
                value = compileStaticGraph030(record(decode(input.document)));
                break;
            case 'registry':
                value = captureRegistry030(input.registry);
                break;
            case 'agent':
                value = captureAgent030(input.document, input.agentName, input.registry);
                break;
            case 'used': {
                const document = record(decode(input.document));
                value = usedProperties030(document, input.agentName, record(decode(input.agent)), input.pointer);
                break;
            }
            case 'contract':
                value = createAgentWorkContract030(input.input);
                break;
            case 'copyContract':
                value = copyContract030(input.contract);
                break;
            case 'source':
                value = captureSourceRevision(input.value);
                break;
            case 'nativeCapture':
                value = captureNativeJson(input.value, input.pointer);
                break;
            case 'metadata':
                value = ({ object: metadataObject, text: metadataText, identity: metadataIdentity, array: metadataArray, json: metadataJson }[input.fn as 'object'])(input.value, input.pointer);
                break;
            case 'encodeHost': return JSON.stringify({ status: 'ok', json: encodeHostCompilation(input.result, input.registry, input.validations) });
            case 'read':
                value = encode(readExactDocument(input.hex === undefined ? input.source : Uint8Array.from(Buffer.from(input.hex, 'hex'))) as ExactObject);
                break;
            case 'addressOrder':
                value = Math.sign(input.left.localeCompare(input.right, 'en'));
                break;
        }
        return JSON.stringify({ status: 'ok', json: JSON.stringify(value) });
    }
    catch (error) {
        if (error instanceof ConformanceError)
            return JSON.stringify({ status: 'failure', code: error.code, pointer: error.pointer, message: error.message });
        return JSON.stringify({ status: error instanceof RangeError ? 'resourceLimit' : 'exception', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) });
    }
}
