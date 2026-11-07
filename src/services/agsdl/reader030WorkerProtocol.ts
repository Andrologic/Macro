import { stringify } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { ReaderOptions030 } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { AgsdlReport } from '../../types/agsdl';

export type WorkerRequest = { primary: Uint8Array; modules?: [string, string][]; moduleError?: string };
export type SourceSpan = { start: number; end: number };
export type WorkerResponse = { report: AgsdlReport; spans: [string, SourceSpan][] } | { error: { name: string; message: string } };

/** Snapshot exact JSON before crossing the structured-clone boundary. */
export function workerRequest(primary: Uint8Array, options?: ReaderOptions030): WorkerRequest {
  if (options?.modules === undefined) return { primary };
  try {
    return { primary, modules: Array.from(options.modules, ([name, module]) => [name, stringify(module)]) };
  } catch (error) {
    // The reader checks input parsing before loading the registry.
    return { primary, moduleError: error instanceof Error ? error.message : String(error) };
  }
}

// Keep source-specific locations out of persisted or agent-facing reports.
const sourceLocations = new WeakMap<AgsdlReport, { source: string; spans: ReadonlyMap<string, SourceSpan> }>();
export function rememberSourceLocations(report: AgsdlReport, source: string, spans: ReadonlyMap<string, SourceSpan>): void {
  sourceLocations.set(report, { source, spans });
}
export function locationsForSource(report: AgsdlReport, source: string): ReadonlyMap<string, SourceSpan> | undefined {
  const stored = sourceLocations.get(report);
  return stored?.source === source ? stored.spans : undefined;
}
