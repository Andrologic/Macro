import { create } from 'zustand';
import type { AgsdlSession, AgsdlTarget } from '../stores/useAgsdlStore';
import { agsdlSessionKey, useAgsdlStore } from '../stores/useAgsdlStore';
import { demoPlans } from './fixtures';
import { launchFields, defaultLaunchRequirements, type LaunchField, type LaunchValues } from './blueprintInputs';
export { launchFields, defaultLaunchRequirements, sampleLaunchValues } from './blueprintInputs';

export const releaseTarget: AgsdlTarget = { branchName: 'main', planId: 'demo-release' };
export type DemoRun = { id: number; snapshot: Pick<AgsdlSession, 'source' | 'annexes' | 'design' | 'display'>; values: LaunchValues; instructions: string; version: string; phase: 'preparing' | 'running' | 'completed' | 'stopped'; step: number };
export const missingLaunchFields = (values: LaunchValues) => launchFields.filter(field => !values[field.id]?.trim());
export function releaseBlueprint() {
  const session = useAgsdlStore.getState().sessions[agsdlSessionKey(releaseTarget)];
  if (session) return session;
  const plan = demoPlans.find(plan => plan.id === releaseTarget.planId)!;
  return { ...plan.agsdl, version: 'demo-v1' };
}
interface JourneyState {
  draft?: DemoRun;
  runs: DemoRun[];
  selected?: number;
  prepare: () => void;
  update: (field: LaunchField, value: string) => void;
  instruct: (value: string) => void;
  start: () => boolean;
  advance: (id: number) => void;
  stop: () => void;
  select: (id: number) => void;
  reset: () => void;
}
let nextRunId = 0;
const simulationTimers = new Map<number, ReturnType<typeof setTimeout>>();
function clearProgress(id: number) {
  clearTimeout(simulationTimers.get(id)); simulationTimers.delete(id);
}
function scheduleProgress(id: number) {
  clearProgress(id);
  if (useBlueprintJourney.getState().runs.find(run => run.id === id)?.phase !== 'running') return;
  simulationTimers.set(id, setTimeout(() => useBlueprintJourney.getState().advance(id), 2200));
}
export const useBlueprintJourney = create<JourneyState>((set, get) => ({
  runs: [],
  prepare() {
    const blueprint = releaseBlueprint();
    const requirements = blueprint.design?.requirements ?? defaultLaunchRequirements();
    const values = Object.fromEntries(launchFields.map(field => [field.id, requirements.find(item => item.id === field.id)?.value ?? ''])) as LaunchValues;
    set({ selected: undefined, draft: { id: ++nextRunId, snapshot: structuredClone({ source: blueprint.source, annexes: blueprint.annexes, design: blueprint.design, display: blueprint.display }), version: blueprint.version, values, instructions: '', phase: 'preparing', step: 0 } });
  },
  update(field, value) { const draft = get().draft; if (draft?.phase === 'preparing') set({ draft: { ...draft, values: { ...draft.values, [field]: value } } }); },
  instruct(instructions) { const draft = get().draft; if (draft?.phase === 'preparing') set({ draft: { ...draft, instructions } }); },
  start() {
    const draft = get().draft;
    if (!draft || draft.phase !== 'preparing' || missingLaunchFields(draft.values).length) return false;
    const run = structuredClone({ ...draft, phase: 'running' as const });
    set({ draft: undefined, selected: run.id, runs: [...get().runs, run] }); scheduleProgress(run.id); return true;
  },
  advance(id) { set(state => ({ runs: state.runs.map(run => run.id === id && run.phase === 'running' ? { ...run, step: Math.min(3, run.step + 1), phase: run.step === 2 ? 'completed' : 'running' } : run) })); scheduleProgress(id); },
  stop() { if (get().selected !== undefined) clearProgress(get().selected!); set(state => ({ runs: state.runs.map(run => run.id === state.selected && run.phase === 'running' ? { ...run, phase: 'stopped' } : run) })); },
  select(selected) { set({ selected }); },
  reset() { for (const id of simulationTimers.keys()) clearProgress(id); set({ draft: undefined, selected: undefined, runs: [] }); },
}));
