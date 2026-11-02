import type { CompilationResult } from './compiler';
import type { CapturedRegistry } from './registry';
import type { NativeToolPolicyResult } from './nativeToolPolicy';

// Keep in sync with CompileBroker's native transport bound, measured in UTF-8 bytes.
export const HOST_COMPILE_RESULT_LIMIT = 8_000_000;
interface Validations {
  readonly entryValidation?: { readonly messageJson: unknown; readonly valid: boolean };
  readonly deliveryValidation?: { readonly input: unknown; readonly valid: boolean };
  readonly callValidation?: { readonly input: unknown; readonly prepared: unknown };
  readonly toolPolicy?: NativeToolPolicyResult;
}
/** A size refusal belongs to this document. Correlation errors still reach the host failure path. */
export function encodeHostCompilation(result: CompilationResult, registry: CapturedRegistry, validations: Validations): string {
  const encoded = JSON.stringify({ ...result, capturedRegistryJson: JSON.stringify(registry), ...validations });
  if (new TextEncoder().encode(encoded).byteLength <= HOST_COMPILE_RESULT_LIMIT) return encoded;
  const diagnostic = { code: 'INPUT_LIMIT', pointer: '', message: 'Expanded compilation exceeds the native result limit.' };
  // Drop expanded declarations and reports, retaining the ticket's exact source,
  // registry version and validation inputs. No successful admission survives refusal.
  return JSON.stringify({
    static: { valid: result.static.valid, diagnostics: [] },
    runtime: { ...result.runtime, supported: false, diagnostics: [diagnostic], unassessed: [] },
    plan: null, compiledPlanJson: null, productRuntimeAvailable: false,
    entryValidation: validations.entryValidation && { messageJson: validations.entryValidation.messageJson, valid: false },
    deliveryValidation: validations.deliveryValidation && { input: validations.deliveryValidation.input, valid: false },
    callValidation: validations.callValidation && { input: validations.callValidation.input, prepared: null },
    toolPolicy: validations.toolPolicy && { input: validations.toolPolicy.input, decision: 'deny', summary: diagnostic.message, detail: null, code: diagnostic.code },
  });
}
