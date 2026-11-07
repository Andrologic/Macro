/** Supplied by the native runtime catalogue, never inferred from Chat provider preferences. */
export interface AgsdlHarnessChoice {
  name: string;
  available: boolean;
  version?: string;
  models: Array<{ name: string; efforts: string[] }>;
}
export interface AgsdlHarnessCatalogue {
  contract: 'agsdl-0.3.0';
  assessment: 'runtime-catalogue' | 'not-assessed';
  harnesses: AgsdlHarnessChoice[];
  reason?: string;
}
export type ReadAgsdlHarnessCatalogue = () => Promise<AgsdlHarnessCatalogue>;
export const unassessedHarnessCatalogue = (): AgsdlHarnessCatalogue => ({
  contract: 'agsdl-0.3.0', assessment: 'not-assessed', harnesses: [],
  reason: 'The native harness catalogue has not been connected. Installation, models, efforts and permission enforcement require runtime Preflight. Model names are open harness names, not encoded Chat provider identities.',
});
