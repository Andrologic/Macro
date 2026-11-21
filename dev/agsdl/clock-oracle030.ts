// Test-only adapter. All decisions come from the shipped TS exports.
import { WorkClock030, HumanWaitRegistry030, associateMcpRequest030 } from '../../src/services/agsdlExecution/workClock030';
import { evaluateHostHumanClock030 } from '../../src/services/agsdlExecution/hostHumanClock030';
import { evaluateHumanClockJob030 } from '../../src/services/agsdlExecution/humanAnswer030';
import { createHostRoutePort030 } from '../../src/services/agsdlExecution/hostRouteBroker030';
import { ConformanceError } from '../../src/services/agsdlExecution/exact';
export interface ClockRequest030 { op: string; json: string }
const ok = (value: unknown) => ({ status: 'ok', json: JSON.stringify(value) });
const errorValue = (error: unknown) => error instanceof ConformanceError
  ? { status: 'failure', code: error.code, pointer: error.pointer, message: error.message }
  : { status: error instanceof RangeError ? 'resourceLimit' : 'exception', name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) };
export async function evaluateClock030(request: ClockRequest030): Promise<string> {
  try {
    const i = JSON.parse(request.json);
    let output: unknown;
    if (request.op === 'host') output = evaluateHostHumanClock030(i.owner, i.eventId, i.expectedRevision, i.stateJson, i.eventJson, i.options);
    else if (request.op === 'job') output = evaluateHumanClockJob030(i);
    else if (request.op === 'broker') output = await createHostRoutePort030(i.generation ?? 'generation').evaluate(i.job);
    else if (request.op === 'associate') output = associateMcpRequest030(i.serverId, i.callsObservable, i.works);
    else if (request.op === 'clock') {
      const clock = new WorkClock030(i.timeoutMs, i.nowMs);
      const steps: unknown[] = [];
      for (const step of i.steps) {
        let result;
        try {
          let value;
          switch (step.op) {
            case 'advance': value = clock.advance(step.nowMs); break;
            case 'open': value = clock.openHuman(step.requestId, step.nowMs); break;
            case 'close': value = clock.closeHuman(step.requestId, step.nowMs); break;
            case 'detach': value = clock.detachHuman(step.requestId, step.nowMs); break;
            case 'wake': value = clock.nextWakeMs(step.maxSliceMs); break;
            case 'snapshot': value = clock.snapshot(); break;
            default: throw new Error('Unknown work-clock step');
          }
          result = ok(value);
          if (step.mutate && value && typeof value === 'object') Object.assign(value, step.mutate);
        } catch (error) { result = errorValue(error); }
        steps.push({ result, snapshot: clock.snapshot() });
      }
      output = { steps, snapshot: clock.snapshot(), timeoutMs: clock.timeoutMs };
    } else if (request.op === 'registry') {
      const registry = new HumanWaitRegistry030();
      const clocks = new Map<string, WorkClock030>();
      const steps: unknown[] = [];
      for (const step of i.steps) {
        let result;
        try {
          let value;
          switch (step.op) {
            case 'create': clocks.set(step.label, new WorkClock030(step.timeoutMs, step.nowMs)); break;
            case 'register': value = registry.registerWork(step.workId, clocks.get(step.label)!, step.answerTimeoutMs); break;
            case 'open': value = registry.open(step.input); break;
            case 'associate': value = registry.setRequestWorks(step.requestId, step.workIds, step.nowMs); break;
            case 'resolve': value = registry.resolve(step.requestId, step.answer, step.nowMs); break;
            case 'tick': value = registry.tick(step.nowMs); break;
            case 'wake': value = registry.nextWakeMs(step.nowMs, step.maxSliceMs); break;
            case 'ack': value = registry.acknowledgeResolution(step.requestId); break;
            case 'retire': value = registry.unregisterWork(step.workId, step.nowMs); break;
            case 'request': value = registry.request(step.requestId); break;
            case 'pending': value = registry.pendingResolutions(); break;
            default: throw new Error('Unknown registry step');
          }
          result = ok(value);
          if (step.mutate && value && typeof value === 'object') Object.assign(value, step.mutate);
          if (step.mutateInput) Object.assign(step.input, step.mutateInput);
        } catch (error) { result = errorValue(error); }
        steps.push({ result, clocks: [...clocks].map(([label, clock]) => ({ label, snapshot: clock.snapshot() })), pending: registry.pendingResolutions() });
      }
      output = { steps };
    } else throw new Error('Unknown clock operation');
    return JSON.stringify(ok(output));
  } catch (error) { return JSON.stringify(errorValue(error)); }
}
