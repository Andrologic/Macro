/** Pure call preparation/receipt normalization. Native policy and effects live elsewhere. */
import type { ExactJsonText } from './contracts';
import { ConformanceError, clone, decimal, decode, encode, fail, has, record, text, NumberToken, type ExactObject } from './exact';
import { readPath030 } from './messages030';
import type { RouteSource030 } from './routes030';

export type PreparedCall030 =
  | { readonly kind: 'command'; readonly command: string; readonly parse?: 'lines' | 'json' }
  | { readonly kind: 'mcp'; readonly server: string; readonly tool: string; readonly argumentsJson: ExactJsonText };
export function prepareCall030(stepJson: ExactJsonText, source: RouteSource030): PreparedCall030 {
  const step = record(decode(stepJson));
  if (step.type !== 'call' || has(step, 'command') === has(step, 'mcp')) return fail('SHAPE', '', 'A call has exactly one command or MCP tool.');
  if (has(step, 'command')) {
    if (has(step, 'arguments') || has(step, 'answerTimeoutMs')) return fail('SHAPE', '', 'MCP-only fields on command.');
    const command = text(step.command);
    if (has(step, 'parse') && step.parse !== 'lines' && step.parse !== 'json') return fail('SHAPE', '/parse', 'Unknown command parser.');
    return Object.freeze({ kind: 'command', command, ...(has(step, 'parse') ? { parse: step.parse as 'lines' | 'json' } : {}) });
  }
  if (has(step, 'parse')) return fail('SHAPE', '/parse', 'parse applies only to commands.');
  const mcp = record(step.mcp);
  if (Object.keys(mcp).some(key => !['server', 'tool'].includes(key))) return fail('SHAPE', '/mcp', 'Invalid MCP target.');
  const output = decode(source.outputJson);
  const args: ExactObject = Object.fromEntries(Object.entries(record(step.arguments ?? {})).map(([name, raw]) => {
    const operand = record(raw);
    if (Object.keys(operand).length !== 1 || has(operand, 'value') === has(operand, 'path')) return fail('OPERAND', '', 'An operand contains exactly value or path.');
    return [name, has(operand, 'value') ? clone(operand.value) : readPath030(output, operand.path)];
  }));
  return Object.freeze({ kind: 'mcp', server: text(mcp.server), tool: text(mcp.tool), argumentsJson: encode(args) });
}
export interface CommandReceipt030 {
  /** Complete decoded streams. The native owner defines binary/signal policy. */
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly exitCodeJson: ExactJsonText;
  readonly complete: boolean;
}
export function commandOutput030(prepared: Extract<PreparedCall030, { kind: 'command' }>, receipt: CommandReceipt030): ExactJsonText {
  if (!receipt.complete) return fail('OUTPUT_INVALID', '', 'Cannot normalize an incomplete command receipt.');
  const exitCode = decode(receipt.exitCodeJson);
  if (!(exitCode instanceof NumberToken) || decimal(exitCode)[2] < 0n) return fail('OUTPUT_INVALID', '', 'Expected an integer exit status.');
  const data: ExactObject = { exitCode, output: receipt.output };
  if (prepared.parse === 'lines') {
    // A CR is removed only when it belongs to a CRLF terminator.
    const parts = receipt.stdout.split('\n');
    data.value = parts.map((line, index) => index < parts.length - 1 && line.endsWith('\r') ? line.slice(0, -1) : line).filter(line => line !== '');
  } else if (prepared.parse === 'json') {
    try { data.value = decode(receipt.stdout); }
    catch (error) {
      if (!(error instanceof ConformanceError)) throw error;
      return fail('OUTPUT_INVALID', '', 'Command stdout is not one exact JSON value.');
    }
  }
  return encode({ outcome: decimal(exitCode)[1] === '0' ? 'passed' : 'failed', data });
}
export interface McpReceipt030 {
  readonly isError: boolean;
  readonly structuredContentJson?: ExactJsonText;
  /** Complete text content before presentation formatting/truncation. */
  readonly text: string;
}
export function mcpOutput030(receipt: McpReceipt030): ExactJsonText {
  const data = receipt.structuredContentJson !== undefined ? decode(receipt.structuredContentJson) : receipt.text;
  return encode({ outcome: receipt.isError ? 'failed' : 'passed', data });
}
