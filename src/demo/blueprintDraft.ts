import { invoke } from '@tauri-apps/api/core';
import type { DemoBlueprintUse } from './blueprintLaunch';

export interface DemoWorkflowDraft {
  id: string;
  blueprintId: string;
  projectId: string;
  objective: string;
  values: Record<string, string>;
}

/** Preserve input order even when an earlier autosave is still awaiting its reply. */
export function createDemoWorkflowDraftWriter(
  persist: (draft: DemoWorkflowDraft) => Promise<DemoBlueprintUse> = draft =>
    invoke<DemoBlueprintUse>('demo_blueprint_prepare', { ...draft }),
) {
  let pending: Promise<DemoBlueprintUse | undefined> = Promise.resolve(undefined);
  return {
    flush: () => pending,
    save(draft: DemoWorkflowDraft): Promise<DemoBlueprintUse> {
      const snapshot = structuredClone(draft);
      const next = pending.catch(() => undefined).then(() => persist(snapshot));
      pending = next;
      return next;
    },
  };
}
