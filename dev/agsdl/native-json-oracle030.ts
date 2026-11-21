// Test-only native boundary oracle. Inputs travel as decimal text or bit patterns.
import { captureNativeJson } from '../../src/services/agsdlExecution/metadata';
export type NativeJsonRequest030 = {
    op: 'decimal';
    raw: string;
} | {
    op: 'bits';
    hex: string;
} | {
    op: 'parse';
    json: string;
};
function bits(value: number): string { const bytes = new ArrayBuffer(8); new DataView(bytes).setFloat64(0, value, false); return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
export function evaluateNativeJson030(request: NativeJsonRequest030): unknown {
    try {
        if (request.op === 'decimal') {
            const value = JSON.parse(request.raw) as number;
            return { status: 'ok', bits: bits(value), text: JSON.stringify(value) };
        }
        if (request.op === 'bits') {
            const bytes = Uint8Array.from(request.hex.match(/../g)!, h => parseInt(h, 16));
            return { status: 'ok', text: JSON.stringify(new DataView(bytes.buffer).getFloat64(0, false)) };
        }
        const value: unknown = JSON.parse(request.json);
        let capture: unknown;
        try {
            capture = { status: 'ok', text: JSON.stringify(captureNativeJson(value, '/native')) };
        }
        catch (error) {
            const e = error as {
                code: string;
                pointer: string;
                message: string;
            };
            capture = { status: 'failure', code: e.code, pointer: e.pointer, message: e.message };
        }
        return { status: 'ok', text: JSON.stringify(value), capture };
    }
    catch {
        return { status: 'parseError' };
    }
}
