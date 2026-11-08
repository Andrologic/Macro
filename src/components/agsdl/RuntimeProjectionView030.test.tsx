import { expect, it } from 'bun:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeProjectionView030, type RuntimeSelection030 } from './RuntimeProjectionView030';
import type { RuntimeProjectionPage030 } from '../../types/generated/ipc/RuntimeProjectionPage030';

it('returns exact group identity and branch position in native order', async () => {
  const source = {owner:{projectId:'p',planId:'plan',branch:'main'},revision:'1',sourceSha256:'a'.repeat(64)};
  const page: RuntimeProjectionPage030 = {scope:{systemStartId:'r',snapshotId:'s',source},flowInvocationId:'f',revision:'1',stopping:false,verdict:null,total:'1',nextPage:null,items:[{kind:'group',value:{id:'group-real',join:['join'],originActivationId:'a',activationId:'b',decision:null,released:false,context:[],parentPathIds:[],branches:[{name:'z',fanout:true,pathIds:['p2','p1']},{name:'a',fanout:false,pathIds:['p0']}]}}]};
  const selections: RuntimeSelection030[] = [];
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const labels = {instances:'Instances',activations:'Activations',groups:'Groups',paths:'Paths',queue:'Queue',physicalWait:'Wait',branchPaths:'Branch paths',physicalEvidenceRequired:'Physical proof required',unnamed:'Unnamed',phase:(value:string)=>value,selector:(value:string)=>value};
  await act(async()=>root.render(<RuntimeProjectionView030 page={page} labels={labels} select={item=>selections.push(item)} />));
  const buttons = [...host.querySelectorAll('button')];
  expect(buttons.map(button=>button.textContent)).toEqual(['join','z','a']);
  await act(async()=>buttons[2].click());
  expect(selections).toEqual([{kind:'branch',groupId:'group-real',branchIndex:1}]);
  await act(async()=>root.unmount()); host.remove();
});

it('renders branch paths and an instance queue in their native order', async () => {
  const source = {owner:{projectId:'p',planId:'plan',branch:'main'},revision:'1',sourceSha256:'a'.repeat(64)};
  const page: RuntimeProjectionPage030 = {scope:{systemStartId:'r',snapshotId:'s',source},flowInvocationId:'f',revision:'1',stopping:false,verdict:null,total:'6',nextPage:null,items:[
    {kind:'instance',value:{id:'i',agent:'worker',selectorKind:'shared',selectorName:null,currentActivationId:null,queueActivationIds:['b','a'],discarded:false}},
    ...['a','b'].map(id => ({kind:'activation' as const,value:{id,step:[id],agent:'worker',instanceId:'i',phase:'queued',physical:false,physicalWaitGroupIds:[],stopRequested:false,context:[],pathIds:[],composeActivationIds:[],nearestFanoutIndex:null}})),
    {kind:'group',value:{id:'g',join:['join'],originActivationId:'a',activationId:'b',decision:null,released:false,context:[],parentPathIds:[],branches:[{name:'branch',fanout:true,pathIds:['p2','p1']}]}},
    ...['p1','p2'].map((id,index) => ({kind:'path' as const,value:{id,batchId:'batch',phase:'live',context:[],nearestFanoutIndex:String(index + 1),memberships:[]}})),
  ]};
  const labels = {instances:'Instances',activations:'Activations',groups:'Groups',paths:'Paths',queue:'Queue',physicalWait:'Wait',branchPaths:'Branch paths',physicalEvidenceRequired:'Physical proof required',unnamed:'Unnamed',phase:(value:string)=>value,selector:(value:string)=>value};
  function Harness() { const [selection,setSelection] = useState<RuntimeSelection030>(); return <RuntimeProjectionView030 page={page} labels={labels} selected={selection} select={setSelection} />; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async()=>root.render(<Harness />));
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent === 'worker · shared')!.click());
  expect([...host.querySelectorAll('ol li')].map(item=>item.textContent)).toEqual(['b','a']);
  await act(async()=>[...host.querySelectorAll('button')].find(button=>button.textContent === 'branch')!.click());
  expect([...host.querySelectorAll('ol li')].map(item=>item.textContent)).toEqual(['2','1']);
  await act(async()=>root.unmount()); host.remove();
});
