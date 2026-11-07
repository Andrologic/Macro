import type { AgentWorkContract030, SubmissionDiagnostic030, SubmissionValidation030, ValueSchemaValidator030 } from './agentWorkContracts030';
import { at, ConformanceError, decode, encode, has, NumberToken, record, type ExactObject, type ExactValue } from './exact';

function isObject030(value: ExactValue | undefined): value is ExactObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof NumberToken);
}
export function requiresSubmission030(contract: AgentWorkContract030): boolean {
  const agent = record(decode(contract.agentJson));
  const results = record(agent.results ?? {});
  return contract.choices !== null || contract.completionCheck !== null || contract.defaultInstructions !== 'none' ||
    Object.values(contract.instructionsByChoice).some(kind => kind !== 'none') ||
    Object.values(results).some(rule => record(rule).required === true);
}

/** Validate a complete candidate, never a partial publication or a merged result. */
export function validateAgentSubmission030(
  contract: AgentWorkContract030, rawArguments: string, validateValueSchema: ValueSchemaValidator030,
): SubmissionValidation030 {
  const diagnostics: SubmissionDiagnostic030[] = [];
  const issue = (pointer: string, rule: string, message: string) => { diagnostics.push({ pointer, rule, message }); };
  let submission: ExactValue;
  try { submission = decode(rawArguments); }
  catch (error) {
    if (!(error instanceof ConformanceError)) throw error;
    return { kind: 'invalid', diagnostics: [{ pointer: '', rule: 'JSON', message: 'Result tool arguments must be exact JSON without duplicate keys.' }] };
  }
  if (!isObject030(submission)) return { kind: 'invalid', diagnostics: [{ pointer: '', rule: 'OBJECT', message: 'Result tool arguments must be an object.' }] };
  for (const key of Object.keys(submission)) if (!['results', 'choice', 'instructions'].includes(key)) issue(at('', key), 'UNKNOWN_ARGUMENT', 'Unknown result tool argument.');
  const agent = record(decode(contract.agentJson));
  const declared = record(agent.results ?? {});
  // Results may be omitted when there are no supplied values, including instruction-only submissions.
  const results = has(submission, 'results') ? submission.results : {};
  if (!isObject030(results)) issue('/results', 'RESULTS_OBJECT', 'Results must be an object of result names to direct values.');
  else {
    for (const name of Object.keys(results)) if (!has(declared, name)) issue(at('/results', name), 'UNKNOWN_RESULT', 'Result name is not declared.');
    for (const [name, declaration] of Object.entries(declared)) {
      const rule = record(declaration), pointer = at('/results', name);
      if (!has(results, name)) {
        if (rule.required === true) issue(pointer, 'REQUIRED_RESULT', 'Required result is missing.');
        continue;
      }
      const value = results[name];
      const mediaType = typeof rule.mediaType === 'string' ? rule.mediaType : 'application/json';
      if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
        if (has(rule, 'schema')) diagnostics.push(...validateValueSchema(value, rule.schema, pointer));
      } else if (mediaType.startsWith('text/')) {
        if (typeof value !== 'string') issue(pointer, 'TEXT_RESULT', 'A text result must be a string.');
      } else if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$/.test(value) || !absoluteUri030(value)) {
        issue(pointer, 'FILE_URI', 'A file result must be an absolute URI of the produced file.');
      }
    }
  }
  const choice = submission.choice;
  if (contract.choices !== null) {
    if (typeof choice !== 'string' || !contract.choices.includes(choice)) issue('/choice', 'CHOICE', 'Choose one of the current step choices.');
  } else if (has(submission, 'choice')) issue('/choice', 'UNEXPECTED_CHOICE', 'This work does not route by choice.');
  const instructionKind = typeof choice === 'string' && has(contract.instructionsByChoice as ExactObject, choice)
    ? contract.instructionsByChoice[choice] : contract.defaultInstructions;
  const instructions = submission.instructions;
  if (has(submission, 'instructions')) {
    if (agent.instructs !== true) issue('/instructions', 'INSTRUCTS', 'This agent is not authorized to write missions.');
    if (instructionKind === 'list') {
      if (!Array.isArray(instructions) || instructions.some(item => typeof item !== 'string')) issue('/instructions', 'INSTRUCTIONS_LIST', 'This route expects a list of mission strings.');
    } else if (typeof instructions !== 'string') issue('/instructions', 'INSTRUCTIONS_STRING', 'This route expects a mission string.');
  } else if (instructionKind !== 'none') issue('/instructions', 'INSTRUCTIONS_REQUIRED', 'The selected route requires instructions.');
  if (diagnostics.length) return { kind: 'invalid', diagnostics };
  const normalizedChoice = typeof choice === 'string' ? choice : null;
  return { kind: 'candidate', candidate: { submissionJson: encode(submission), resultsJson: encode(results!),
    choice: normalizedChoice, instructions: instructions === undefined ? null : instructions as string | string[],
    checkRequired: contract.completionCheck !== null && (contract.completionCheck.choices === null || normalizedChoice !== null && contract.completionCheck.choices.includes(normalizedChoice)) } };
}
function absoluteUri030(value: string): boolean {
  // WHATWG URL accepts relative references only with a base, which is never supplied.
  try { new URL(value); return !/%(?![0-9a-fA-F]{2})/.test(value); } catch { return false; }
}
