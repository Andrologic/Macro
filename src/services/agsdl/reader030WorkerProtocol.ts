import { stringify } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { ReaderOptions030 } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { AgsdlReport } from '../../types/agsdl';

export type WorkerRequest = { primary: Uint8Array; modules?: [string, string][]; moduleError?: string };
export type SourceSpan = { start: number; end: number };
export type WorkerResponse = { report: AgsdlReport; spans: [string, SourceSpan][] } | { error: { name: string; message: string } };

/** Snapshot exact JSON before crossing the structured-clone boundary. */
export function workerRequest(primary: Uint8Array, options?: ReaderOptions030): WorkerRequest {
  if (options?.modules === undefined) return { primary };
  const modules: [string, string][] = [];
  try {
    for (const [name, module] of options.modules) modules.push([name, stringify(module)]);
    return { primary, modules };
  } catch (error) {
    // Keep earlier entries: their validation errors take precedence over this one.
    return { primary, modules, moduleError: error instanceof Error ? error.message : String(error) };
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
