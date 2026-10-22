import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SaveSystemDialog } from './SaveSystemDialog';
import { agsdlSessionKey, useAgsdlStore } from '../../stores/useAgsdlStore';
import { createExample } from '../../services/agsdl/examples';
import * as blueprints from '../../stores/agsdl/blueprints';
import * as exports from '../../services/agsdl/exportDocument';

const target = { branchName: 'develop', planId: 'save-system-test' };
const key = agsdlSessionKey(target);
let root: Root;
let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); mock.restore(); useAgsdlStore.setState({ sessions: {} }); });
const mount = async (dirty = false) => {
  useAgsdlStore.setState({ sessions: { [key]: { source: createExample('feature'), annexes: { 'note.txt': 'evidence' }, version: 'v1', persistedRevision: 1, dirty, saving: false, status: 'draft', history: [], future: [], reports: [], error: null } } });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<SaveSystemDialog target={target} title="Feature" onClose={() => {}} />));
};
const button = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === name)!;

test('project save uses the document store and already saved work does not need another save', async () => {
  await mount();
  expect(button('Save').disabled).toBe(true);
  const save = spyOn(useAgsdlStore.getState(), 'save').mockResolvedValue(undefined);
  act(() => useAgsdlStore.setState(state => ({ sessions: { [key]: { ...state.sessions[key], dirty: true } } })));
  await act(async () => button('Save').click());
  expect(save).toHaveBeenCalledWith(target);
});
test('blueprint failures remain recoverable and a successful copy cannot be created twice', async () => {
  const save = spyOn(blueprints, 'saveBlueprint').mockRejectedValueOnce(new Error('failed')).mockResolvedValue({} as Awaited<ReturnType<typeof blueprints.saveBlueprint>>);
  await mount();
  act(() => button('Blueprint').click());
  await act(async () => button('Create blueprint').click());
  expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
  expect(button('Create blueprint').disabled).toBe(false);
  await act(async () => button('Create blueprint').click());
  expect(save).toHaveBeenCalledWith(target, 'Feature', undefined, 'v1');
  expect(button('Create blueprint').disabled).toBe(true);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
});
test('export selects the complete snapshot without changing the source or creating a blueprint', async () => {
  const download = spyOn(exports, 'downloadAgsdlExport').mockImplementation(() => {});
  const save = spyOn(blueprints, 'saveBlueprint');
  await mount();
  const source = useAgsdlStore.getState().sessions[key].source;
  act(() => button('Export').click());
  const format = document.body.querySelector<HTMLSelectElement>('select')!;
  act(() => { format.value = 'macro'; format.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => button('Download').click());
  expect(JSON.parse(download.mock.calls[0][0].content).agsdl).toMatchObject({ source, annexes: { 'note.txt': 'evidence' } });
  expect(save).not.toHaveBeenCalled();
  expect(useAgsdlStore.getState().sessions[key].source).toBe(source);
});
