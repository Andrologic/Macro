import type { FlowDocumentContract } from "../../vendor/agsdl/v0.4/reader.mjs";

export const AGSDL_CONTRACT = "agsdl-0.4.0";

export function isFlowDocumentContract(contract: unknown): contract is FlowDocumentContract {
  return contract === "agsdl-0.3.0" || contract === AGSDL_CONTRACT;
}
