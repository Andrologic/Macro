import type { ExactJsonText } from './contracts';
import { clone, decode, equal, fail, has, list, NumberToken, record, text } from './exact';
import { integer030, type Integer030 } from './workIntegers030';

export type InstructionKind030 = 'none' | 'string' | 'list';
export interface AgentWorkContract030 {
  readonly version: 'macro-agsdl-agent-work/030';
  readonly agentJson: ExactJsonText;
  readonly choices: readonly string[] | null;
  readonly instructionsByChoice: Readonly<Record<string, InstructionKind030>>;
  readonly defaultInstructions: InstructionKind030;
  readonly maxCorrections: Integer030;
  readonly completionCheck: null | { readonly command: string; readonly choices: readonly string[] | null; readonly maxFailures: Integer030 };
  readonly timeoutMs: Integer030 | null;
  readonly answerTimeoutMs: Integer030 | null;
  readonly planFirst: 'auto' | 'ask' | null;
}
export interface SubmissionDiagnostic030 {
  readonly pointer: string;
  readonly rule: string;
  readonly message: string;
}
export interface SubmissionCandidate030 {
  readonly submissionJson: ExactJsonText;
  readonly resultsJson: ExactJsonText;
  readonly choice: string | null;
  readonly instructions: string | readonly string[] | null;
  readonly checkRequired: boolean;
}
export type SubmissionValidation030 =
  | { readonly kind: 'invalid'; readonly diagnostics: readonly SubmissionDiagnostic030[] }
  | { readonly kind: 'candidate'; readonly candidate: SubmissionCandidate030 };

/** Supplied by reader01. The AST uses the very same NumberToken as exact.ts. */
export type ValueSchemaValidator030 = (
  value: import('./exact').ExactValue, schema: import('./exact').ExactValue, pointer: string,
) => readonly SubmissionDiagnostic030[];

export interface AgentWorkContractInput030 {
  /** Expanded, statically validated 0.3 agent declaration. */
  readonly agentJson: ExactJsonText;
  readonly choices?: readonly string[] | null;
  readonly instructionsByChoice?: Readonly<Record<string, InstructionKind030>>;
  readonly defaultInstructions?: InstructionKind030;
  readonly timeoutMs?: Integer030 | null;
}
function kind030(value: InstructionKind030): InstructionKind030 {
  if (!['none', 'string', 'list'].includes(value)) fail('CORRELATION', '', 'Unknown route instruction cardinality.');
  return value;
}
function names030(names: readonly string[]): readonly string[] {
  if (names.some(name => typeof name !== 'string' || !name.length) || new Set(names).size !== names.length) fail('CORRELATION', '', 'Choice names must be distinct nonempty strings.');
  return Object.freeze([...names]);
}
/** Snapshot once. Caller mutations cannot change an admitted work's contract. */
export function createAgentWorkContract030(input: AgentWorkContractInput030): AgentWorkContract030 {
  const agent = record(decode(input.agentJson));
  const choices = input.choices == null ? null : names030(input.choices);
  if (choices?.length === 0) fail('CORRELATION', '/choices', 'A choice-routed step needs at least one choice.');
  const routes = Object.fromEntries(Object.entries(input.instructionsByChoice ?? {}).map(([choice, kind]) => {
    if (!choices?.includes(choice)) fail('CORRELATION', '/instructionsByChoice', 'Instruction requirements refer to an unknown choice.');
    return [choice, kind030(kind)];
  }));
  const defaultInstructions = kind030(input.defaultInstructions ?? 'none');
  if ((defaultInstructions !== 'none' || Object.values(routes).some(kind => kind !== 'none')) && agent.instructs !== true) fail('CORRELATION', '/instructs', 'The route requires instructions from an agent that cannot instruct.');
  const numberField = (key: string, fallback: string | null, positive = false): Integer030 | null => has(agent, key)
    ? integer030(importNumber030(agent[key]), positive) : fallback;
  let check: AgentWorkContract030['completionCheck'] = null;
  if (has(agent, 'completionCheck')) {
    const value = record(agent.completionCheck);
    const command = text(value.command);
    if (!command.trim()) fail('CORRELATION', '/completionCheck/command', 'A completion check needs a command.');
    const filter = has(value, 'choices') ? names030(list(value.choices).map(item => text(item))) : null;
    // The document validator checks the union of choices across all uses of this
    // definition. Keep its filter unchanged, including for graphless works.
    check = Object.freeze({ command, choices: filter, maxFailures: has(value, 'maxFailures') ? integer030(importNumber030(value.maxFailures)) : '3' });
  }
  const planFirst = agent.planFirst ?? null;
  if (planFirst !== null && planFirst !== 'auto' && planFirst !== 'ask') fail('CORRELATION', '/planFirst', 'Unknown plan-first mode.');
  return Object.freeze({ version: 'macro-agsdl-agent-work/030', agentJson: input.agentJson,
    choices, instructionsByChoice: Object.freeze(routes), defaultInstructions,
    maxCorrections: numberField('maxCorrections', '2')!, completionCheck: check,
    timeoutMs: input.timeoutMs == null ? null : integer030(input.timeoutMs, true),
    answerTimeoutMs: numberField('answerTimeoutMs', null, true), planFirst });
}
function importNumber030(value: import('./exact').ExactValue): string {
  // Authored numeric tokens stay lexical; a string is never coerced to a limit.
  if (!(value instanceof NumberToken)) fail('CORRELATION', '', 'An authored limit must be a JSON number.');
  return value.raw;
}

export function copyContract030(contract: AgentWorkContract030): AgentWorkContract030 {
  const captured = createAgentWorkContract030({ agentJson: contract.agentJson, choices: contract.choices,
    instructionsByChoice: contract.instructionsByChoice, defaultInstructions: contract.defaultInstructions, timeoutMs: contract.timeoutMs });
  if (contract.version !== captured.version || contract.maxCorrections !== captured.maxCorrections || contract.answerTimeoutMs !== captured.answerTimeoutMs || contract.planFirst !== captured.planFirst ||
      !equal(contract.completionCheck, captured.completionCheck)) fail('CORRELATION', '', 'Work contract differs from the captured agent declaration.');
  return clone(captured);
}
