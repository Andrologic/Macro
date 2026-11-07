import { loadHarnessModule, ModuleError, readWithSpans, stringify } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { WorkerRequest, WorkerResponse } from './reader030WorkerProtocol';

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  let response: WorkerResponse;
  try {
    const { primary, modules, moduleError } = event.data;
    let loaded: Map<string, ReturnType<typeof loadHarnessModule>> | undefined;
    const options = modules === undefined && moduleError === undefined ? undefined : {
      get modules() {
        if (loaded) return loaded;
        const entries = new Map<string, ReturnType<typeof loadHarnessModule>>();
        for (const [name, json] of modules ?? []) {
          const module = loadHarnessModule(new TextEncoder().encode(json));
          if (name !== module.name) throw new ModuleError(`module registry key '${name}' does not match name '${module.name}'`);
          entries.set(name, module);
        }
        if (moduleError !== undefined) throw new ModuleError(moduleError);
        return loaded = entries;
      },
    };
    const { report, spans } = readWithSpans(primary, options);
    const locations: [string, { start: number; end: number }][] = [];
    for (const { path } of report.diagnostics) {
      const span = spans.get(path);
      if (span) locations.push([path, span]);
    }
    response = { spans: locations, report: {
      operation: 'readDocument', contract: report.contract,
      scope: 'document-and-harness-declarations', executionSupport: 'not-assessed',
      documentReportJson: stringify(report), annexesAssessment: 'not-used-by-contract',
      results: [{ input: 'primary', unit: 'document', verdict: report.valid ? 'pass' : 'fail',
        findings: report.diagnostics.map(diagnostic => ({
          rule: diagnostic.code, outcome: diagnostic.severity === 'warning' ? 'warning' : 'fail',
          severity: diagnostic.severity, details: diagnostic.message,
          location: { pointer: diagnostic.path },
          ...(diagnostic.step === undefined ? {} : { step: diagnostic.step }),
        })),
      }],
    } };
  } catch (error) {
    response = { error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } };
  }
  self.postMessage(response);
};
