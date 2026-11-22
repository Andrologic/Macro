import { AGSDL_CONTRACT } from './contract';
import type { FlowDocumentContract } from '../../vendor/agsdl/v0.4/reader.mjs';

/** Supplied by the native runtime catalogue, never inferred from Chat provider preferences. */
export interface AgsdlHarnessChoice {
  name: string;
  available: boolean;
  version?: string;
  models: Array<{ name: string; efforts: string[] }>;
}
export interface AgsdlHarnessCatalogue {
  contract: FlowDocumentContract;
  assessment: 'runtime-catalogue' | 'not-assessed';
  harnesses: AgsdlHarnessChoice[];
  reason?: string;
}
export type ReadAgsdlHarnessCatalogue = () => Promise<AgsdlHarnessCatalogue>;
export const unassessedHarnessCatalogue = (contract: FlowDocumentContract = AGSDL_CONTRACT): AgsdlHarnessCatalogue => ({
  contract, assessment: 'not-assessed', harnesses: [],
  reason: 'The native harness catalogue has not been connected. Installation, models, efforts and permission enforcement require runtime Preflight. Model names are open harness names, not encoded Chat provider identities.',
});
