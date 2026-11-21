import { useAgsdlTranslation } from './useAgsdlTranslation';
import { runtimeSections030 } from '../../services/agsdl/runtimeProjection030';
import type { RuntimeProjectionPage030 } from '../../types/generated/ipc/RuntimeProjectionPage030';

export type RuntimeSelection030 =
  | { kind: 'instance' | 'activation' | 'group' | 'path'; id: string }
  | { kind: 'branch'; groupId: string; branchIndex: number };
export interface RuntimeLabels030 { instances: string; activations: string; groups: string; paths: string; queue: string; physicalWait: string; branchPaths: string; physicalEvidenceRequired: string; unnamed: string; phase: (value: string) => string; selector: (value: string) => string }
/** Presentation preserves native order and returns native IDs rather than
 * deriving execution identities from the static graph. */
export function RuntimeProjectionView030({ page, labels, select, selected }: { page: RuntimeProjectionPage030; labels: RuntimeLabels030; select: (selection: RuntimeSelection030) => void; selected?: RuntimeSelection030 }) {
  const { t } = useAgsdlTranslation();
  const tr = (key: string) => t(`agsdl.run030.${key}`);
  // A raw first page is never a complete fan-out, even if its visible list is empty.
  if (page.nextPage !== null || !/^(0|[1-9][0-9]*)$/.test(page.total) || BigInt(page.total) !== BigInt(page.items.length)) {
    return <p role="status">{tr('incomplete')}</p>;
  }
  const sections = runtimeSections030(page);
  const chosen = (kind: 'instance' | 'activation' | 'group' | 'path', id: string) => selected?.kind === kind && 'id' in selected && selected.id === id;
  const instance = selected?.kind === 'instance' ? sections.instances.find(item => item.id === selected.id) : undefined;
  const activation = selected?.kind === 'activation' ? sections.activations.find(item => item.id === selected.id) : undefined;
  const branch = selected?.kind === 'branch' ? sections.groups.find(item => item.id === selected.groupId)?.branches[selected.branchIndex] : undefined;
  const button = 'block w-full rounded px-2 py-1 text-left hover:bg-accent aria-pressed:bg-accent';
  return <div className="space-y-2">
    <section><h3 className="font-medium">{labels.instances}</h3>{sections.instances.map(item => <button className={button} aria-pressed={chosen('instance',item.id)} type="button" key={item.id} onClick={() => select({kind:'instance',id:item.id})}>{item.agent} · {labels.selector(item.selectorKind)}{item.selectorName ? ` · ${item.selectorName}` : ''}</button>)}</section>
    <section><h3 className="font-medium">{labels.activations}</h3>{sections.activations.map(item => <button className={button} aria-pressed={chosen('activation',item.id)} type="button" key={item.id} onClick={() => select({kind:'activation',id:item.id})}>{item.step?.join(' / ') || item.agent || labels.unnamed} · {labels.phase(item.phase)}{item.physical ? ` · ${labels.physicalEvidenceRequired}` : ''}</button>)}</section>
    <section><h3 className="font-medium">{labels.groups}</h3>{sections.groups.map(group => <div key={group.id}><button className={button} aria-pressed={chosen('group',group.id)} type="button" onClick={() => select({kind:'group',id:group.id})}>{group.join.join(' / ')}</button><p>{tr('groupDecision')}: {group.decision === null ? tr('noDecision') : tr(`decision.${['done', 'incomplete', 'reached', 'missed', 'closed', 'failed'].includes(group.decision) ? group.decision : 'unknown'}`)}</p><details><summary>{tr('technicalDetails')}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(group, null, 2)}</pre></details>{group.branches.map((branch,index) => <button className={`${button} pl-4`} aria-pressed={selected?.kind === 'branch' && selected.groupId === group.id && selected.branchIndex === index} type="button" key={index} onClick={() => select({kind:'branch',groupId:group.id,branchIndex:index})}>{branch.name}</button>)}</div>)}</section>
    <section><h3 className="font-medium">{labels.paths}</h3>{sections.paths.map(path => <button className={button} aria-pressed={chosen('path',path.id)} type="button" key={path.id} onClick={() => select({kind:'path',id:path.id})}>{path.nearestFanoutIndex ?? labels.unnamed} · {labels.phase(path.phase)}</button>)}</section>
    {instance && <section><h3 className="font-medium">{labels.queue}</h3><ol>{instance.queueActivationIds.map(id => {
      const queued = sections.activations.find(item => item.id === id);
      return <li key={id}>{queued?.step?.join(' / ') || queued?.agent || labels.unnamed}</li>;
    })}</ol></section>}
    {activation && activation.physicalWaitGroupIds.length > 0 && <section><h3 className="font-medium">{labels.physicalWait}</h3><ul>{activation.physicalWaitGroupIds.map(id => <li key={id}>{sections.groups.find(group => group.id === id)?.join.join(' / ') || labels.unnamed}</li>)}</ul></section>}
    {selected?.kind === 'path' && <details><summary>{tr('technicalDetails')}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(sections.paths.find(path => path.id === selected.id), null, 2)}</pre></details>}
    {instance && <details><summary>{tr('technicalDetails')}</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(instance, null, 2)}</pre></details>}
    {branch && <section><h3 className="font-medium">{labels.branchPaths}</h3><ol>{branch.pathIds.map(id => <li key={id}>{sections.paths.find(path => path.id === id)?.nearestFanoutIndex ?? labels.unnamed}</li>)}</ol></section>}
  </div>;
}
