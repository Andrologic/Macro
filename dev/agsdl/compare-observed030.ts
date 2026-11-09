import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from '../../src/vendor/agsdl/v0.3/json.mjs';
import { compareRun030 } from './run-expect030';
import { observeRun030 } from './observe-run030';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// Fixture correlation only. Admission/qualification remains a native decision.
const scenarioNames = new Set([
  'answer-timeout-ask', 'answer-timeout-plan', 'approval', 'approval-comments',
  'call-answer-timeout', 'command-json-invalid', 'command-lines', 'command-outcome',
  'compose-body-failure', 'composition', 'delivery-queue', 'delivery-steer',
  'error-route', 'fanout-empty', 'fanout-keep', 'fanout-limit', 'fanout-max-failures',
  'fanout-missions', 'fanout-one-at-a-time', 'fanout-operand', 'finish-branch-goes-on',
  'flow-error', 'join-all', 'join-branch-failed', 'join-branch-steer', 'join-group-closes',
  'mission-priority', 'parallel-no-join', 'quorum-finish', 'quorum-missed',
  'quorum-reached', 'quorum-unreachable', 'quorum-wait', 'sequence-loop',
  'timeout-pauses-for-person', 'visit-limit', 'wait-group-closes',
]);

// Correlate a native QA result with its fixture. This is not an authority receipt.
// Run only after the QA application and its database pool have exited.
export async function compareObserved030(resultPath: string, database: string) {
  const envelope: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
  if (!object(envelope) || envelope.ok !== true || !object(envelope.result)) throw new Error('Invalid native scenario result');
  const result = envelope.result, scenario = result.scenario, receipt = result.receipt;
  if (!object(scenario) || typeof scenario.name !== 'string' || !scenarioNames.has(scenario.name)
    || typeof scenario.fixtureSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(scenario.fixtureSha256)
    || !object(receipt) || typeof receipt.systemStartId !== 'string' || !receipt.systemStartId
    || typeof receipt.flowInvocationId !== 'string' || !receipt.flowInvocationId) {
    throw new Error('Invalid native scenario result');
  }
  const bytes = await readFile(join(import.meta.dir, 'fixtures/v0.3/conformance/runs', `${scenario.name}.json`));
  const fixtureSha256 = createHash('sha256').update(bytes).digest('hex');
  if (fixtureSha256 !== scenario.fixtureSha256) throw new Error('Scenario fixture differs');
  const fixture = parse(bytes);
  if (fixture.error || !fixture.tree || typeof fixture.tree !== 'object' || Array.isArray(fixture.tree) || !('expect' in fixture.tree)) {
    throw new Error('Invalid pinned conformance fixture');
  }
  const observed = observeRun030(database, receipt.systemStartId, receipt.flowInvocationId);
  const diagnostics = compareRun030(stringify(fixture.tree.expect), observed);
  return { scenario: { name: scenario.name, fixtureSha256 }, fixtureSha256,
    observedSha256: createHash('sha256').update(observed).digest('hex'), observedJson: observed, diagnostics };
}

if (import.meta.main) {
  const [resultPath, database] = process.argv.slice(2);
  if (!resultPath || !database || process.argv.length !== 4) throw new Error('Usage: compare-observed030 <result.json> <database>');
  const compared = await compareObserved030(resultPath, database);
  console.log(JSON.stringify(compared));
  if (compared.diagnostics.length) process.exitCode = 1;
}
