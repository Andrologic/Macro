import type { FlowDocumentContract } from "../../types/agsdl";

export const AGSDL_CONTRACT = "agsdl-0.4.0";
const LEGACY_FLOW_CONTRACT = "agsdl-0.3.0";

export type { FlowDocumentContract } from "../../types/agsdl";

export function isFlowDocumentContract(contract: unknown): contract is FlowDocumentContract {
  return contract === LEGACY_FLOW_CONTRACT || contract === AGSDL_CONTRACT;
}
