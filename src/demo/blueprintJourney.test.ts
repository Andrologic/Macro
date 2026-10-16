import { afterEach, expect, test } from 'bun:test';
import { useBlueprintJourney, releaseTarget, missingLaunchFields, defaultLaunchRequirements } from './blueprintJourney';
import { agsdlSessionKey, useAgsdlStore } from '../stores/useAgsdlStore';
import { demoPlans } from './fixtures';
const key = agsdlSessionKey(releaseTarget);
afterEach(() => { useBlueprintJourney.getState().reset(); useAgsdlStore.setState({ sessions: {} }); });
const complete = () => {
  const state = useBlueprintJourney.getState();
  state.update('releaseVersion', '2.4.0'); state.update('releasePackages', 'Luma 2.4 · macOS et Windows');
  state.update('releaseModel', 'Macro AI · Équilibré'); state.update('releaseRepository', 'GitHub · luma/mobile · lecture seule');
};
test('Architect defaults prefill Operate while missing values block launch', () => {
  useBlueprintJourney.getState().prepare();
  const draft = useBlueprintJourney.getState().draft!;
  expect(draft.values.releaseModel).toBe('Macro AI · Équilibré');
  expect(missingLaunchFields(draft.values).map(field => field.id)).toEqual(['releaseVersion', 'releasePackages', 'releaseRepository']);
  expect(useBlueprintJourney.getState().start()).toBe(false);
  expect(useBlueprintJourney.getState().runs).toHaveLength(0);
});
test('a model intentionally left open in Architect is required in Operate', () => {
  const document = demoPlans.find(plan => plan.id === releaseTarget.planId)!.agsdl;
  useAgsdlStore.setState({ sessions: { [key]: { ...document, version: 'edited', persistedRevision: 1, status: 'draft', saving: false, dirty: false, history: [], future: [], reports: [], error: null, design: { ...document.design!, requirements: defaultLaunchRequirements().map(item => ({ ...item, value: '' })) } } } });
  useBlueprintJourney.getState().prepare();
  expect(missingLaunchFields(useBlueprintJourney.getState().draft!.values)).toHaveLength(4);
});
test('execution keeps its source and instructions separate from later blueprint edits and uses', () => {
  useBlueprintJourney.getState().prepare(); complete();
  useBlueprintJourney.getState().instruct('Contrôler les signatures.');
  const source = useBlueprintJourney.getState().draft!.snapshot.source;
  expect(useBlueprintJourney.getState().start()).toBe(true);
  const run = useBlueprintJourney.getState().runs[0];
  expect(run.instructions).toBe('Contrôler les signatures.');
  const document = demoPlans.find(plan => plan.id === releaseTarget.planId)!.agsdl;
  const changed = JSON.parse(source);
  const firstAgent = Object.keys(changed.agents)[0];
  changed.agents[firstAgent].prompt = [{ value: 'Nouvelle consigne permanente.' }];
  const changedSource = JSON.stringify(changed);
  useAgsdlStore.setState({ sessions: { [key]: { ...document, source: changedSource, version: 'v2', persistedRevision: 2, status: 'draft', saving: false, dirty: false, history: [], future: [], reports: [], error: null } } });
  useBlueprintJourney.getState().prepare();
  expect(useBlueprintJourney.getState().draft!.snapshot.source).toBe(changedSource);
  useBlueprintJourney.getState().update('releaseVersion', '2.5.0');
  useBlueprintJourney.getState().instruct('Autre consigne.');
  expect(useBlueprintJourney.getState().runs[0].values.releaseVersion).toBe('2.4.0');
  expect(useBlueprintJourney.getState().runs[0].instructions).toBe('Contrôler les signatures.');
  expect(useBlueprintJourney.getState().runs[0].snapshot.source).toBe(source);
  expect(useBlueprintJourney.getState().draft!.id).not.toBe(run.id);
});
test('Stop is terminal and late simulated progress cannot restart the execution', () => {
  useBlueprintJourney.getState().prepare(); complete(); useBlueprintJourney.getState().start();
  const id = useBlueprintJourney.getState().runs[0].id;
  useBlueprintJourney.getState().advance(id); useBlueprintJourney.getState().stop();
  useBlueprintJourney.getState().advance(id);
  expect(useBlueprintJourney.getState().runs[0]).toMatchObject({ step: 1, phase: 'stopped' });
});
test('three simulated completions finish the captured release without duplicate admissions', () => {
  useBlueprintJourney.getState().prepare(); complete(); expect(useBlueprintJourney.getState().start()).toBe(true);
  expect(useBlueprintJourney.getState().start()).toBe(false);
  const id = useBlueprintJourney.getState().runs[0].id;
  for (let index = 0; index < 5; index++) useBlueprintJourney.getState().advance(id);
  expect(useBlueprintJourney.getState().runs).toHaveLength(1);
  expect(useBlueprintJourney.getState().runs[0]).toMatchObject({ step: 3, phase: 'completed' });
});
