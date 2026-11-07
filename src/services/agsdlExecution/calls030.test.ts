import { describe, expect, it } from 'bun:test';
import type { ExactJsonText } from './contracts';
import { ConformanceError, decode, record } from './exact';
import { commandOutput030, mcpOutput030, prepareCall030, type CommandReceipt030 } from './calls030';
import type { RouteSource030 } from './routes030';

const j = (raw: string) => raw as ExactJsonText;
const source: RouteSource030 = { terminalId: 't', producerStep: ['source'], kind: 'call', outputJson: j('{"data":{"n":9007199254740993,"d":0.123456789012345678901,"xs":[null]}}'), provenance: { instructions: [] } };
const command = (parse?: 'lines' | 'json') => ({ kind: 'command' as const, command: 'synthetic', ...(parse ? { parse } : {}) });
const receipt = (stdout: string, exitCode = '0'): CommandReceipt030 => ({ stdout, stderr: '{"stderr":"not data"}', output: `${stdout}\ncombined stderr`, exitCodeJson: j(exitCode), complete: true });
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error('Expected failure'); } catch (error) { expect(error).toBeInstanceOf(ConformanceError); expect((error as ConformanceError).code).toBe(expected); }
}
describe('AgSDL 0.3 call preparation without effects', () => {
  it('keeps command text literal and MCP arguments exact without interpolation', () => {
    expect(prepareCall030(j('{"type":"call","command":"echo $DATA ${results.n}","parse":"json"}'), source)).toEqual({ kind: 'command', command: 'echo $DATA ${results.n}', parse: 'json' });
    const result = prepareCall030(j('{"type":"call","mcp":{"server":"document_server","tool":"tool"},"arguments":{"n":{"path":["data","n"]},"d":{"path":["data","d"]},"literal":{"value":{"uri":"literal","ref":"literal","from":["data"]}},"nil":{"path":["data","xs",0e20]},"all":{"path":[]}}}'), source);
    expect(result).toMatchObject({ kind: 'mcp', server: 'document_server', tool: 'tool' });
    if (result.kind !== 'mcp') throw new Error('Expected MCP');
    expect(result.argumentsJson).toContain('"n":9007199254740993,"d":0.123456789012345678901');
    expect(result.argumentsJson).toContain('"literal":{"uri":"literal","ref":"literal","from":["data"]},"nil":null');
    expect(source.outputJson).toContain('9007199254740993');
    expect(prepareCall030(j('{"type":"call","mcp":{"server":"s","tool":"t"}}'), source)).toMatchObject({ argumentsJson: '{}' });
  });
  it('rejects shape errors and unresolved operands before a native invocation can exist', () => {
    for (const raw of ['{"type":"call"}', '{"type":"call","command":"x","mcp":{}}', '{"type":"call","command":"x","arguments":{}}', '{"type":"call","command":"x","answerTimeoutMs":1}', '{"type":"call","command":"x","parse":"yaml"}', '{"type":"call","mcp":{"server":"s","tool":"t"},"parse":"json"}']) code(() => prepareCall030(j(raw), source), 'SHAPE');
    for (const operand of ['{"path":["missing"]}', '{"path":["data","xs","0"]}', '{"value":1,"path":[]}', '{}']) code(() => prepareCall030(j(`{"type":"call","mcp":{"server":"s","tool":"t"},"arguments":{"x":${operand}}}`), source), 'OPERAND');
  });
});
describe('complete command receipts', () => {
  it('parses only LF/CRLF, omitting empty lines and retaining spaces and isolated CR', () => {
    const result = record(decode(commandOutput030(command('lines'), receipt('A\r\n\n \nB\rC\nlast\r'))));
    expect(record(result.data).value).toEqual(['A', ' ', 'B\rC', 'last\r']);
    expect(record(decode(commandOutput030(command('lines'), receipt('')))).data).toMatchObject({ value: [] });
  });
  it('preserves every JSON value and exact number tokens for either normal outcome', () => {
    for (const value of ['null', 'true', '"text"', '9007199254740993', '0.123456789012345678901', '[1,null]', '{"n":9007199254740993}']) {
      for (const exitCode of ['0', '1', '0e20', '1.0']) {
        const result = commandOutput030(command('json'), receipt(` \r\n${value}\t`, exitCode));
        expect(result).toContain(`"value":${value}`);
        expect(result).toContain(`"outcome":"${exitCode.startsWith('0') ? 'passed' : 'failed'}"`);
      }
    }
  });
  it('keeps combined output separate from stdout parsing and refuses invalid or incomplete data', () => {
    const raw = receipt('1', '1');
    expect(record(record(decode(commandOutput030(command('json'), raw))).data)).toMatchObject({ output: raw.output });
    expect(commandOutput030(command('json'), raw)).toContain('"value":1');
    expect(commandOutput030(command(), raw)).not.toContain('"value":');
    for (const exitCode of ['0', '1']) for (const stdout of ['', '1 2', '{bad}', '{"a":1,"a":2}']) code(() => commandOutput030(command('json'), receipt(stdout, exitCode)), 'OUTPUT_INVALID');
    code(() => commandOutput030(command(), { ...raw, complete: false }), 'OUTPUT_INVALID');
  });
});
describe('original MCP receipts', () => {
  it('prioritizes present structured content and uses only the original isError outcome', () => {
    for (const value of ['{}', 'null', 'false', '{"n":9007199254740993,"d":0.123456789012345678901}']) for (const isError of [true, false]) {
      expect(mcpOutput030({ structuredContentJson: j(value), text: 'ignored', isError })).toBe(j(`{"outcome":"${isError ? 'failed' : 'passed'}","data":${value}}`));
    }
    expect(mcpOutput030({ text: 'server text', isError: true })).toBe(j('{"outcome":"failed","data":"server text"}'));
    expect(mcpOutput030({ text: '', isError: false })).toBe(j('{"outcome":"passed","data":""}'));
  });
});
