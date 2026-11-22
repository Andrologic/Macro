import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { hasFlowDocumentContract, validateDocument, validateDocumentBytes } from './document';
import { localizeDiagnostics } from './diagnostics';
import type { ViewerCard } from './viewer';
import { loadHarnessModule, ModuleError, parse, stringify } from '../../vendor/agsdl/v0.4/reader.mjs';
import type { HarnessModule030 } from '../../vendor/agsdl/v0.4/reader.mjs';

const root = new URL('../../../dev/agsdl/fixtures/v0.4/', import.meta.url);
const bytes = (text: string) => new TextEncoder().encode(text);
const fixture = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));
const modules = new Map(['example', 'limited'].map(name => [name, loadHarnessModule(fixture(`conformance/modules/${name}/module.json`))]));
const text = (data: Uint8Array) => new TextDecoder().decode(data);

async function compare(source: string, options?: { modules: ReadonlyMap<string, HarnessModule030> }) {
  const native = validateDocumentBytes(bytes(source), options);
  const result = (await validateDocument(source, {}, options))[0];
  expect(JSON.parse(result.documentReportJson as string)).toEqual(native);
  expect(result.results[0].findings).toEqual(native.diagnostics.map(d => ({ rule: d.code,
    outcome: d.severity === 'warning' ? 'warning' : 'fail', severity: d.severity,
    details: d.message, location: { pointer: d.path }, ...(d.step === undefined ? {} : { step: d.step }) })));
}

describe('AgSDL flow worker', () => {
  it('matches native reports across the 147 cases, examples and scenario documents', async () => {
    let count = 0;
    for (const folder of ['conformance/cases', 'examples', 'conformance/runs']) {
      for (const name of readdirSync(new URL(`${folder}/`, root)).filter(n => n.endsWith('.json'))) {
        let data = fixture(`${folder}/${name}`);
        if (folder.endsWith('/runs')) {
          const scenario = parse(data).tree as { document: unknown };
          data = typeof scenario.document === 'string' ? fixture(`conformance/${scenario.document}`) : bytes(stringify(scenario.document));
        }
        const source = text(data);
        // Malformed JSON and other editions follow the existing dispatch; bytes remain a pure API.
        const parsed = parse(data);
        if (parsed.error) {
          const worker = new Worker(new URL('./reader030.worker.ts', import.meta.url), { type: 'module' });
          const result = await new Promise<{ report: { documentReportJson: string } }>((resolve, reject) => {
            worker.onmessage = event => { worker.terminate(); resolve(event.data); };
            worker.onerror = error => { worker.terminate(); reject(error); };
            worker.postMessage({ primary: data });
          });
          expect(JSON.parse(result.report.documentReportJson)).toEqual(validateDocumentBytes(data));
          count++;
          continue;
        }
        const contract = JSON.parse(source).contract;
        if (contract === 'agsdl-0.4.0') await compare(source, folder === 'examples' ? undefined : { modules });
        count++;
      }
    }
    expect(count).toBe(207);
  }, 60000);
  it('dispatches top-level 0.3 markers even when escaped, late or followed by invalid JSON', async () => {
    const valid = '{"id":"late","agents":{},"content":{"x":{"value":"} \\"contract\\":\\"agsdl-0.1.0\\""}},"\\u0063ontract":"agsdl-0.3.0"}';
    expect(hasFlowDocumentContract(valid)).toBe(true);
    expect((await validateDocument(valid))[0].contract).toBe('agsdl-0.3.0');
    const nested = '{"contract":"agsdl-0.2.0","other":{"contract":"agsdl-0.3.0"}}';
    expect(hasFlowDocumentContract(nested)).toBe(false);
    expect((await validateDocument(nested))[0].contract).toBe('agsdl-0.2.0');
    const malformed = '{"contract":"agsdl-0.3.0","id":"x","agents":{},';
    const [report] = await validateDocument(malformed);
    expect(report.contract).toBe('agsdl-0.3.0');
    expect(report.results[0].findings[0].rule).toBe('PARSE');
    const invalid = { ...modules.get('example')!, name: '\ud800' };
    const [beforeModules] = await validateDocument(malformed, {}, { modules: new Map([['x', invalid]]) });
    expect(beforeModules.results[0].findings[0].rule).toBe('PARSE');
    await expect(validateDocument(valid, {}, { modules: new Map([['x', invalid]]) })).rejects.toBeInstanceOf(ModuleError);
  });
  it('handles deeply nested literal data without synchronous span construction', async () => {
    const depth = 16000;
    const literal = '['.repeat(depth) + '0' + ']'.repeat(depth);
    const source = `{"id":"deep","agents":{"a":{"harness":"unknown","permissions":"full"}},"content":{"x":{"value":${literal}}},"contract":"agsdl-0.3.0"}`;
    let completed = false;
    const start = performance.now();
    const pending = validateDocument(source).then(result => { completed = true; return result; });
    const synchronousMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 0));
    const tickMs = performance.now() - start;
    expect(completed).toBe(false);
    const [report] = await pending;
    expect(report.results[0].verdict).toBe('pass');
    const cards: ViewerCard[] = [{ path: '/agents/a', id: 'a', kind: 'Agent', title: '', mission: '',
      unresolved: false, inputs: [], outputs: [], branches: [], details: { agentName: 'a' } }];
    const localizeStart = performance.now();
    const findings = localizeDiagnostics(source, [report], cards);
    const localizationMs = performance.now() - localizeStart;
    expect(findings.find(item => item.rule === 'HARNESS_UNVERIFIED')?.targets).toEqual(['/agents/a']);
    console.log(`deep literal localization: ${localizationMs.toFixed(1)} ms`);
    console.log(`deep literal: ${bytes(source).length} bytes, sync ${synchronousMs.toFixed(1)} ms, tick ${tickMs.toFixed(1)} ms, total ${(performance.now() - start).toFixed(1)} ms`);
  }, 30000);
  it('preserves numeric modules, empty and default registries, and module errors', async () => {
    const json = '{"name":"custom","version":"1.0.0","contract":"agsdl-0.3.0","harnessVersions":"*","properties":{},"permissions":{},"settings":{"type":"object","properties":{"limit":{"type":"number","enum":[900719925474099312345,1.00000000000000000001]}}}}';
    const custom = loadHarnessModule(bytes(json));
    const source = '{"contract":"agsdl-0.3.0","id":"test","agents":{"a":{"harness":"custom","permissions":"full","harnessSettings":{"limit":900719925474099312345}}},"content":{"n":{"value":1e999999999999999999}}}';
    expect(validateDocumentBytes(bytes(source), { modules: new Map([['custom', custom]]) }).valid).toBe(true);
    await compare(source, { modules: new Map([['custom', custom]]) });
    await compare(source, { modules: new Map() });
    await compare(source);
    await expect(validateDocument(source, {}, { modules: new Map([['wrong', custom]]) })).rejects.toBeInstanceOf(ModuleError);
    const invalid = { ...custom, name: '\ud800' };
    await expect(validateDocument(source, {}, { modules: new Map([['x', invalid]]) })).rejects.toBeInstanceOf(ModuleError);
    const ordered = { modules: new Map([['wrong', custom], ['later', invalid]]) };
    let expected = '';
    try { validateDocumentBytes(bytes(source), ordered); } catch (error) { expected = (error as Error).message; }
    expect(expected).toContain("module registry key 'wrong'");
    await expect(validateDocument(source, {}, ordered)).rejects.toThrow(expected);
  });
  it('keeps mutable module property order across the worker serialization boundary', async () => {
    const module = loadHarnessModule(fixture('conformance/modules/example/module.json'));
    const source = '{"contract":"agsdl-0.3.0","id":"order","agents":{}}';
    Object.assign(module, { '2': false }); Object.assign(module, { '1': true });
    const options = { modules: new Map([['example', module]]) };
    expect(() => validateDocumentBytes(bytes(source), options)).toThrow('/2:');
    await expect(validateDocument(source, {}, options)).rejects.toThrow('/2:');
    Reflect.deleteProperty(module, '2'); Object.assign(module, { '2': false });
    expect(() => validateDocumentBytes(bytes(source), options)).toThrow('/1:');
    await expect(validateDocument(source, {}, options)).rejects.toThrow('/1:');
  });
  it('keeps parallel responses separate', async () => {
    const a = '{"contract":"agsdl-0.3.0","id":"a","agents":{}}';
    const b = '{"contract":"agsdl-0.3.0","id":"b","agents":{"a":{"harness":"unknown","permissions":"full"}}}';
    const reports = await Promise.all([validateDocument(a), validateDocument(b)]);
    expect(JSON.parse(reports[0][0].documentReportJson as string)).toEqual(validateDocumentBytes(bytes(a)));
    expect(JSON.parse(reports[1][0].documentReportJson as string)).toEqual(validateDocumentBytes(bytes(b)));
  });
  it('terminates workers on errors, unreadable messages and post failures', async () => {
    const original = globalThis.Worker;
    const source = '{"contract":"agsdl-0.3.0","id":"a","agents":{}}';
    try {
      for (const mode of ['error', 'messageerror', 'post', 'invalid', 'malformed-error', 'success'] as const) {
        let terminated = false;
        class FakeWorker {
          onmessage: ((e: MessageEvent) => void) | null = null;
          onerror: ((e: ErrorEvent) => void) | null = null;
          onmessageerror: (() => void) | null = null;
          postMessage() {
            if (mode === 'post') throw new Error('post failed');
            queueMicrotask(() => {
              if (mode === 'error') this.onerror?.({ message: 'broken' } as ErrorEvent);
              else if (mode === 'messageerror') this.onmessageerror?.();
              else if (mode === 'malformed-error') this.onmessage?.({ data: { error: null } } as MessageEvent);
              else if (mode === 'success') this.onmessage?.({ data: { report: { operation: 'readDocument', results: [] }, spans: [] } } as MessageEvent);
              else this.onmessage?.({ data: null } as MessageEvent);
            });
          }
          terminate() { terminated = true; }
        }
        globalThis.Worker = FakeWorker as unknown as typeof Worker;
        if (mode === 'success') expect((await validateDocument(source))[0].operation).toBe('readDocument');
        else await expect(validateDocument(source)).rejects.toThrow();
        expect(terminated).toBe(true);
      }
      globalThis.Worker = undefined as unknown as typeof Worker;
      await expect(validateDocument(source)).rejects.toThrow('requires Web Worker');
    } finally { globalThis.Worker = original; }
  });
  it('lets the event loop run while a real worker validates a deep document', async () => {
    const compositions: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) compositions[`c${i}`] = { entry: 's', outputs: ['done'], steps: { s: i === 999
      ? { type: 'agent', agent: 'a', next: { output: 'done' } }
      : { type: 'compose', composition: `c${i + 1}`, next: { done: { output: 'done' } } } } };
    const source = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'deep', agents: { a: { harness: 'unknown', permissions: 'full' } },
      flow: { entry: 's', steps: { s: { type: 'compose', composition: 'c0', next: { done: [] } } } }, compositions });
    let completed = false;
    const start = performance.now();
    const pending = validateDocument(source, {}, { modules: new Map() }).then(result => { completed = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const tick = performance.now() - start;
    expect(completed).toBe(false);
    const [report] = await pending;
    expect(report.results[0].verdict).toBe('pass');
    console.log(`real worker: ${bytes(source).length} bytes, event-loop tick ${tick.toFixed(1)} ms, completion ${(performance.now() - start).toFixed(1)} ms`);
  }, 30000);
});
