import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { encode as encodeExecution, decode as decodeExecution, record as executionRecord, NumberToken as ExecutionToken } from '../agsdlExecution/exact';
import { equal } from '../../vendor/agsdl/v0.3/reader.mjs';
import { AGSDL_CONTRACT, AGSDL_020_CONTRACT, LEGACY_AGSDL_CONTRACT, readDocument, readExactDocument, validateDocument, validateDocumentBytes, applyChanges, sourceAt, object, MAX_AGSDL_BYTES } from './document';
import { NumberToken, parse, stringify, loadHarnessModule } from '../../vendor/agsdl/v0.3/reader.mjs';
import { localizeDiagnostics } from './diagnostics';
import { rememberSourceLocations } from './reader030WorkerProtocol';
import type { ViewerCard } from './viewer';
import type { AgsdlReport } from '../../types/agsdl';

const bytes = (source: string) => new TextEncoder().encode(source);
const source = (extra = '') => `{"contract":"agsdl-0.3.0","id":"test","agents":{}${extra}}`;

describe('AgSDL 0.3 document boundary', () => {
  it('dispatches explicit editions and keeps exact numbers separate from business objects', async () => {
    expect([AGSDL_CONTRACT, AGSDL_020_CONTRACT, LEGACY_AGSDL_CONTRACT]).toEqual(['agsdl-0.3.0', 'agsdl-0.2.0', 'agsdl-0.1.0']);
    const raw = source(',"content":{"n":{"value":900719925474099312345}}');
    const document = readDocument(raw);
    const number = object(object(document.content).n).value;
    expect(number).toBeInstanceOf(NumberToken);
    expect(object(number)).toEqual({});
    expect(stringify(readExactDocument(bytes(raw)))).toContain('900719925474099312345');
    expect((await validateDocument(raw))[0].results[0].verdict).toBe('pass');
    expect(validateDocumentBytes(bytes(raw)).valid).toBe(true);
    expect(() => readExactDocument('1')).toThrow('object');
  });
  it('preserves raw numbers through replacements and parent edits using one token identity', () => {
    const raw = source(',"content":{"opaque":{"value":{"huge":1e999999999999999999999,"fraction":1.00000000000000000001}}}');
    const doc = readExactDocument(raw);
    const value = object(object(object(doc.content).opaque).value);
    expect(value.huge).toBeInstanceOf(NumberToken);
    expect(parse(bytes('1')).tree).toBeInstanceOf(NumberToken);
    const edited = applyChanges(raw, [
      { op: 'set', path: '/content/opaque/value/new', valueJson: '1.00e-999999999999999999999' },
      { op: 'remove', path: '/content/opaque/value/fraction' },
    ]);
    expect(sourceAt(edited, '/content/opaque/value/huge')).toBe('1e999999999999999999999');
    expect(sourceAt(edited, '/content/opaque/value/new')).toBe('1.00e-999999999999999999999');
    expect(() => applyChanges(raw, [{ op: 'set', path: '/contract', valueJson: '"agsdl-0.2.0"' }])).toThrow('edition change');
  });
  it('shares token identity with execution helpers and encodes every published example losslessly', () => {
    expect(NumberToken).toBe(ExecutionToken);
    const exact = readExactDocument(source(',"content":{"n":{"value":[900719925474099312345,1.00e999999999999999999999,1.00000000000000000001]}}'));
    const encoded = encodeExecution(exact);
    expect(encoded).toContain('1.00e999999999999999999999');
    expect(encoded).not.toContain('"raw"');
    expect(equal(decodeExecution(encoded), exact)).toBe(true);
    const numeric = object(object(exact.content).n).value as NumberToken[];
    expect(numeric[0]).toBeInstanceOf(ExecutionToken);
    expect(() => executionRecord(numeric[0])).toThrow('Expected an object');
    const folder = new URL('../../../dev/agsdl/fixtures/v0.3/examples/', import.meta.url);
    const names = readdirSync(folder).filter(name => name.endsWith('.json'));
    expect(names).toHaveLength(10);
    for (const name of names) {
      const document = readExactDocument(readFileSync(new URL(name, folder)));
      const encodedDocument = encodeExecution(document);
      expect(equal(decodeExecution(encodedDocument), document)).toBe(true);
      expect(validateDocumentBytes(bytes(encodedDocument))).toEqual(validateDocumentBytes(bytes(stringify(document))));
    }
  });
  it('rejects malformed UTF-16 before encoding and distinguishes replacement characters', async () => {
    for (const broken of ['\ud800', '\udc00', '\ud800x']) {
      const raw = source(`,"content":{"x":{"value":"${broken}"}}`);
      expect(() => readDocument(raw)).toThrow('surrogate');
      expect(() => readExactDocument(raw)).toThrow('surrogate');
      expect((await validateDocument(raw))[0].results[0].findings[0].rule).toBe('PARSE');
    }
    for (const valid of ['😀', '\ufffd', '\\ud83d\\ude00']) {
      expect(validateDocumentBytes(bytes(source(`,"content":{"x":{"value":"${valid}"}}`))).valid).toBe(true);
    }
    expect(validateDocumentBytes(new Uint8Array([0xff])).diagnostics[0].code).toBe('PARSE');
    expect(validateDocumentBytes(bytes(source().replace('"id":"test"', '"id":"test","\\u0069d":"other"'))).diagnostics[0].code).toBe('PARSE');
  });
  it('keeps editor limits separate from normative validity', async () => {
    const raw = source(`,"content":{"large":{"value":"${'x'.repeat(MAX_AGSDL_BYTES)}"}}`);
    expect(validateDocumentBytes(bytes(raw)).valid).toBe(true);
    expect(readExactDocument(raw).contract).toBe(AGSDL_CONTRACT);
    await expect(validateDocument(raw)).rejects.toThrow('1 MiB');
  });
  it('keeps warnings valid, preserves native reports, and respects an empty registry', async () => {
    const raw = JSON.stringify({ contract: AGSDL_CONTRACT, id: 'warn', agents: { worker: { harness: 'unverified', permissions: 'workspace', model: { name: 'example' } } } });
    const [report] = await validateDocument(raw, {}, { modules: new Map() });
    expect(report.results[0].verdict).toBe('pass');
    expect(report.results[0].findings.some(f => f.severity === 'warning' && f.rule === 'HARNESS_UNVERIFIED' && f.outcome === 'warning')).toBe(true);
    expect(JSON.parse(report.documentReportJson as string)).toEqual(validateDocumentBytes(bytes(raw), { modules: new Map() }));
    expect(report.scope).toBe('document-and-harness-declarations');
    expect(report.executionSupport).toBe('not-assessed');
    expect(() => loadHarnessModule(bytes('{}'))).toThrow();
  });
  it('uses worker locations only for the source they were generated from', async () => {
    const raw = source(',"agents":{"worker":{"harness":"unknown","permissions":"full"}}').replace('"agents":{},', '');
    const cards: ViewerCard[] = [{ path: '/agents/worker', id: 'worker', kind: 'Agent',
      title: '', mission: '', unresolved: false, inputs: [], outputs: [], branches: [], details: { agentName: 'worker' } }];
    const reports = await validateDocument(raw);
    const diagnostics = localizeDiagnostics(raw, reports, cards);
    const warning = diagnostics.find(item => item.rule === 'HARNESS_UNVERIFIED');
    expect(warning?.targets).toEqual(['/agents/worker']);
    expect(warning?.span).toBeDefined();
    expect(localizeDiagnostics(raw.replace('"unknown"', '"different"'), reports, cards)
      .find(item => item.rule === 'HARNESS_UNVERIFIED')?.targets).toEqual([]);
    expect(localizeDiagnostics(raw, [], cards)).toEqual([]);
  });
  it('preserves normative paths and expanded steps; harness findings target only agent details', () => {
    const raw = source(',"flow":{"entry":"use","steps":{"use":{"type":"agent","agent":"worker"}}}').replace('"agents":{}', '"agents":{"worker":{"harness":"unknown"}}');
    const cards: ViewerCard[] = [
      { path: '/flow/steps/use', id: 'use', kind: 'agent', details: { agent: 'worker' } },
      { path: '/agents/worker', id: 'worker', kind: 'Agent', details: { agentName: 'worker' } },
    ].map(card => ({ title: '', mission: '', unresolved: false, inputs: [], outputs: [], branches: [], ...card }));
    const report: AgsdlReport = { operation: 'readDocument', results: [{ input: 'primary', unit: 'document', verdict: 'fail', findings: [
      { rule: 'HARNESS_UNVERIFIED', outcome: 'warning', severity: 'warning', details: '', location: { pointer: '/agents/worker/harness' } },
      { rule: 'REFERENCE', outcome: 'fail', severity: 'error', details: '', location: { pointer: '/missing/field' }, step: ['use', 'inner'] },
    ] }] };
    const spanStart = raw.indexOf('"unknown"');
    rememberSourceLocations(report, raw, new Map([['/agents/worker/harness', { start: spanStart, end: spanStart + 9 }]]));
    const diagnostics = localizeDiagnostics(raw, [report], cards);
    expect(diagnostics[0].targets).toEqual(['/agents/worker']);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[1].path).toBe('/missing/field');
    expect(diagnostics[1].span).toBeUndefined();
    expect(diagnostics[1].step).toEqual(['use', 'inner']);
    expect(diagnostics[1].targets).toEqual([]);
  });
});
