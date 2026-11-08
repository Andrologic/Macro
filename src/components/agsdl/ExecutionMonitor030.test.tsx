import { afterEach, expect, it, spyOn } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAgsdlExecutionStore } from '../../stores/useAgsdlExecutionStore';
import { useChatStore } from '../../stores/useChatStore';
import { ExecutionMonitor030 } from './ExecutionMonitor030';

let root: Root | undefined;
let host: HTMLDivElement;
const executionState = useAgsdlExecutionStore.getState();
const chatState = useChatStore.getState();
afterEach(() => { act(() => root?.unmount()); host?.remove(); useAgsdlExecutionStore.setState(executionState); useChatStore.setState(chatState); });
it('shows attested requests as read-only and identifies an incomplete projection', async () => {
  const owner = { projectId: 'p', planId: 'plan', branch: 'work' };
  const source = { owner, revision: '1', sourceSha256: 'a'.repeat(64) };
  const versions = { snapshot: '2' as const, contract: 'agsdl-0.3.0' as const, profile: 'macro-agsdl-030-v1' as const, compiler: 'c', runtime: 'r', registry: 'v' };
  const scope = { systemStartId: 'run', source };
  useChatStore.setState({ selectedConversationId: 'chat' });
  useAgsdlExecutionStore.setState({ owner, conversationId: 'chat', busy: false, humans030Stale: false,
    runs030: [{ systemStartId: 'run', flowInvocationId: 'flow', source, versions, snapshotId:'capture', revision:'1', stopping:false, verdict:null, ownerStatus:'active', phaseCounts:[], physicalPending:'0' }],
    snapshot030: { systemStartId: 'run', source, versions, authoredSource: '{}', associations: {} },
    humans030: { scope, cursor: '', total: '2', nextPage: null, requests: [{ id: 'req', revision: '0', status: 'open', workIds: [], content: {kind:'approval',title:'Review',description:'Detail',message:'Input',choices:['continue']} },
      { id:'question', revision:'0', status:'open', workIds:[], content:{kind:'question',question:'Question text',expectedResponse:'Description only'} }] } });
  const open = spyOn(useAgsdlExecutionStore.getState(), 'open030').mockResolvedValue();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ExecutionMonitor030 target={{planId:'plan',branchName:'work'}} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('Review');
  expect(host.textContent).toContain('The request list may be incomplete.');
  expect(host.textContent).toContain('Responses are not available yet.');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(host.textContent).toContain('Question text');
  expect(host.querySelectorAll('textarea')).toHaveLength(1);
  expect(open).toHaveBeenCalledTimes(1);
  expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('run');
  await act(async () => useAgsdlExecutionStore.setState({runs030:[]}));
  const selectedRun = host.querySelector<HTMLSelectElement>('select')!;
  expect(selectedRun.value).toBe('run');
  expect(selectedRun.selectedOptions[0].textContent).toBe('Captured version');
  expect(Array.from(selectedRun.options).filter(option => option.value === 'run')).toHaveLength(1);
  await act(async () => useAgsdlExecutionStore.setState({runs030Error:true,error:undefined}));
  expect(host.textContent).toContain('The run list may be out of date. Refresh it.');
  await act(async () => useAgsdlExecutionStore.setState({runs030Error:false}));
  expect(host.textContent).not.toContain('The run list may be out of date. Refresh it.');
  open.mockRestore();
});
