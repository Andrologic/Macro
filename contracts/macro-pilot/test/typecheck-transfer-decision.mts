import type { DecisionBinding, DecisionRequest, DecisionContext, DecisionLedger, DecisionRecord } from '../v2/transfer-decision.js';
import { planDecision, decodeDecision, exactInteger, type DecisionPlan } from '../v2/transfer-decision-validate.mjs';
import { parseStoredJsonStrict } from '../v2/strict-json.mjs';

export function consumePlan(request: DecisionRequest, ledger: DecisionLedger | null, record: DecisionRecord | null, context: DecisionContext): void {
  const plan: DecisionPlan = planDecision(request, ledger, record, context);
  if (!plan.valid) { const code: string = plan.code; void code; return; }
  switch (plan.kind) {
    case 'mutation': exactInteger(plan.reservation_bytes); void plan.ledger.birth; break;
    case 'retry': case 'terminal': void plan.receipt.receipt_id; break;
    case 'status': void plan.status.terminal; break;
    case 'source_status': void plan.status.ledger; break;
    default: { const exhaustive: never = plan; void exhaustive; }
  }
  // @ts-expect-error a synchronous plan is not a Promise or a durable commit
  const promise: Promise<DecisionPlan> = plan;
  void promise;
}
const decoded = decodeDecision('{}', 'binding');
if (decoded.valid) { const binding: DecisionBinding = decoded.value; exactInteger(binding.epoch); }
const parsed: unknown = parseStoredJsonStrict('{}'); void parsed;
// @ts-expect-error epoch must retain exact decimal digits
const epoch: DecisionBinding['epoch'] = 9007199254740992;
void epoch;
// @ts-expect-error no permissive content operation exists
const operation: DecisionRequest['operation'] = 'content.read';
void operation;
