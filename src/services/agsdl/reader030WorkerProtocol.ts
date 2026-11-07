import { ModuleError, stringify } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { ReaderOptions030 } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { AgsdlReport } from '../../types/agsdl';

export type WorkerRequest = { primary: Uint8Array; modules?: [string, string][] };
export type WorkerResponse = { report: AgsdlReport } | { error: { name: string; message: string } };

/** Snapshot exact JSON before crossing the structured-clone boundary. */
export function workerRequest(primary: Uint8Array, options?: ReaderOptions030): WorkerRequest {
  if (options?.modules === undefined) return { primary };
  try {
    return { primary, modules: Array.from(options.modules, ([name, module]) => [name, stringify(module)]) };
  } catch (error) {
    throw new ModuleError(error instanceof Error ? error.message : String(error));
  }
}
