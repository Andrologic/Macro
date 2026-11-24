// Only the shipped TS exports supply the work oracle. Payloads and results
// remain JSON text so native UTF-16, numeric parsing and property order survive.
import { AgentWorkController030 } from '../../src/services/agsdlExecution/agentWorkController030';
import { createAgentWorkContract030 } from '../../src/services/agsdlExecution/agentWorkContracts030';
import { requiresSubmission030, validateAgentSubmission030 } from '../../src/services/agsdlExecution/agentSubmission030';
import { evaluateHostWork030 } from '../../src/services/agsdlExecution/hostWorkTransition030';
import { evaluateWorkJournal030 } from '../../src/services/agsdlExecution/hostWorkJournal030';
import { assembleVisibleText } from '../../src/services/agsdlExecution/invariants';
import { ConformanceError } from '../../src/services/agsdlExecution/exact';
import { connectValueSchemaValidator030 } from '../../src/services/agsdlExecution/valueSchemaPort030';
import { NumberToken, parse } from '../../src/vendor/agsdl/v0.4/json.mjs';
import { validate } from '../../src/vendor/agsdl/v0.4/valueschema.mjs';
export interface WorkRequest030 { op: 'controller' | 'submission' | 'requires' | 'visible' | 'host' | 'journal' | 'parse'; json: string }
const validator = connectValueSchemaValidator030({ NumberToken, parse, validate });
const errorValue = (error: unknown) => error instanceof ConformanceError
    ? { status: 'failure', code: error.code, pointer: error.pointer, message: error.message }
    : { status: error instanceof RangeError ? 'resourceLimit' : 'exception', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) };
const ok = (value: unknown) => ({ status: 'ok', json: JSON.stringify(value) });
export function evaluateWork030(request: WorkRequest030): string {
    try {
        const input = JSON.parse(request.json);
        let output: unknown;
        if (request.op === 'parse') return JSON.stringify(ok(JSON.parse(input.raw)));
        if (request.op === 'visible') return JSON.stringify(ok(assembleVisibleText(input.messages)));
        if (request.op === 'host') {
            output = evaluateHostWork030(input.context, input.eventId, input.expectedRevision, input.contractJson, input.stateJson, input.eventJson, input.optionsJson, validator);
        } else {
            const contract = input.contract ?? createAgentWorkContract030(input.contractInput ?? { agentJson: input.agent ?? '{}' });
            if (request.op === 'submission') output = validateAgentSubmission030(contract, input.raw, validator);
            else if (request.op === 'requires') output = requiresSubmission030(contract);
            else if (request.op === 'journal') {
                output = evaluateWorkJournal030(input.stateJson, input.expectedRevision, input.eventJson, () => new AgentWorkController030(input.owner, contract, validator, input.options));
            } else {
                const controller = new AgentWorkController030(input.owner, contract, validator, input.options);
                const steps: unknown[] = [];
                if (input.mutateContract) Object.assign(contract, input.mutateContract);
                if (input.mutateOptions) Object.assign(input.options, input.mutateOptions);
                for (const step of input.steps) {
                    let result;
                    try {
                        if (step.kind === 'snapshot') {
                            const snapshot = controller.snapshot();
                            result = ok(snapshot);
                            if (step.mutate) Object.assign(snapshot, step.mutate);
                        } else if (step.kind === 'allows') result = ok(controller.allowsEffect(step.effect));
                        else {
                            const event = step.input ?? { owner: input.owner, eventId: step.id, event: step.event };
                            const receipt = controller.dispatch(event);
                            result = ok(receipt);
                            if (step.mutateReceipt) Object.assign(receipt, step.mutateReceipt);
                            if (step.mutateEvent) Object.assign(event.event, step.mutateEvent);
                        }
                    } catch (error) { result = errorValue(error); }
                    steps.push(result);
                }
                output = { steps, snapshot: controller.snapshot() };
            }
        }
        return JSON.stringify(ok(output));
    } catch (error) { return JSON.stringify(errorValue(error)); }
}
