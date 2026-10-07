import { expect, it } from 'bun:test';
import { qaFailureReason, qaTerminalOutcome } from './qaGraphless';
import { ConformanceError, decode, shape } from './exact';
import { schema } from '../../vendor/agsdl/v0.2/values.mjs';
import { json } from './conformanceFixtures';
import type { Sequence } from './contracts';
import { StreamStopUnconfirmedError } from '../ai/streamCancellation';

it('keeps only bounded phase and recognized code in the QA diagnostic', () => {
  expect(qaFailureReason('executeAgent', new ConformanceError('CORRELATION', '/private/path', 'private payload')))
    .toBe('Resident execution failed at executeAgent (CORRELATION); terminal receipt unconfirmed.');
  for (const error of [new Error('private payload'), { code: 'private payload', context: { secret: 'private payload' } }, null]) {
    expect(qaFailureReason('commitTerminal', error))
      .toBe('Resident execution failed at commitTerminal (UNEXPECTED); terminal receipt unconfirmed.');
  }
  expect(qaFailureReason('executeAgent', new StreamStopUnconfirmedError('private payload')))
    .toBe('Resident execution failed at executeAgent (STOP_UNCONFIRMED); terminal receipt unconfirmed.');
});

const closedSuccess = {
  cursor: '0' as Sequence, digest: 'retained-native-digest',
  validation: { kind: 'success' as const, text: '', resultsJson: json('{}'), choice: null },
};
const closedConstraintFailure = {
  ...closedSuccess, validation: { kind: 'failure' as const, code: 'OUTPUT_CONSTRAINT' as const, diagnostics: [] },
};
it('maps a closed Agent failure to the official portable AGENT_FAILED error', () => {
  const outcome = qaTerminalOutcome({ closure: closedSuccess, stopped: false, failed: true });
  expect(outcome.kind).toBe('failed');
  if (outcome.kind !== 'failed') throw new Error('Expected failed terminal');
  expect(outcome.code).toBe('AGENT_FAILED');
  expect(JSON.parse(outcome.errorJson).error.code).toBe('AGENT_FAILED');
  expect(shape(decode(outcome.errorJson), schema.$defs.ErrorInput)).toBe(true);
});
it('keeps Stop prior to both Agent failure and output constraint failure', () => {
  for (const closure of [closedSuccess, closedConstraintFailure]) {
    expect(qaTerminalOutcome({ closure, stopped: true, failed: true }))
      .toEqual({ kind: 'stopped', evidenceJson: '{"kind":"native-response-closure"}' });
  }
});
it('preserves OUTPUT_CONSTRAINT regardless of the Agent failure flag', () => {
  for (const failed of [false, true]) {
    const outcome = qaTerminalOutcome({ closure: closedConstraintFailure, stopped: false, failed });
    if (outcome.kind !== 'failed') throw new Error('Expected failed terminal');
    expect(outcome.code).toBe('OUTPUT_CONSTRAINT');
    expect(JSON.parse(outcome.errorJson).error.code).toBe('OUTPUT_CONSTRAINT');
    expect(shape(decode(outcome.errorJson), schema.$defs.ErrorInput)).toBe(true);
  }
});
