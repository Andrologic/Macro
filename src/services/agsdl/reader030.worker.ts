import { loadHarnessModule, read, stringify } from '../../vendor/agsdl/v0.3/reader.mjs';
import type { WorkerRequest, WorkerResponse } from './reader030WorkerProtocol';

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  let response: WorkerResponse;
  try {
    const { primary, modules } = event.data;
    const options = modules === undefined ? undefined : {
      modules: new Map(modules.map(([name, json]) => [name, loadHarnessModule(new TextEncoder().encode(json))])),
    };
    const report = read(primary, options);
    response = { report: {
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
