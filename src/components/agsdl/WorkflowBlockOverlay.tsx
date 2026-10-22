import { useEffect, useId, useRef, useState, cloneElement, type ReactElement } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Sparkles, Wrench } from 'lucide-react';
import type { ViewerCard } from '../../services/agsdl/viewer';
import type { TrackedTask } from '../../services/agsdl/taskTracking';
import type { NativeCardActivation } from '../../services/agsdl/executionView';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import { WorkflowGraphPopup, type GraphPopupAction } from './WorkflowGraphPopup';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export function WorkflowBlockSummary({ card, incoming = [], outgoing = [] }: { card: ViewerCard; incoming?: string[]; outgoing?: string[] }) {
  const { t } = useAgsdlTranslation();
  const prompt = card.promptSources?.find(source => source.kind === 'text' && !source.reference && source.text?.trim())?.text || card.mission;
  const tools = [...new Set(card.tools?.map(tool => tool.label).filter(Boolean))];
  return <>
    {prompt && <p className="agsdl-block-prompt">{prompt}</p>}
    {incoming.length > 0 && <div className="agsdl-block-relation"><ArrowDownToLine size={13} aria-hidden="true" /><span><small>{t('agsdl.graphInteraction.from')}</small>{incoming.join(' · ')}</span></div>}
    {outgoing.length > 0 && <div className="agsdl-block-relation"><ArrowUpFromLine size={13} aria-hidden="true" /><span><small>{t('agsdl.graphInteraction.to')}</small>{outgoing.join(' · ')}</span></div>}
    {card.capabilities?.skills.length ? <div className="agsdl-block-relation"><Sparkles size={13} aria-hidden="true" /><span>{card.capabilities.skills.join(' · ')}</span></div> : null}
    {tools.length > 0 && <div className="agsdl-block-relation"><Wrench size={13} aria-hidden="true" /><span>{tools.join(' · ')}</span></div>}
  </>;
}

export function WorkflowBlockOverlay({ card, title, kindLabel, task, native, incoming, outgoing, actions, children, dismissSignal }: {
  card: ViewerCard; title: string; kindLabel: string; task?: TrackedTask; native?: NativeCardActivation;
  incoming: string[]; outgoing: string[]; actions: GraphPopupAction[]; children: ReactElement<{ "aria-describedby"?: string }>; dismissSignal?: number;
}) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const suppressed = useRef(false);
  const [preview, setPreview] = useState(false);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const id = useId();
  const show = () => { clearTimeout(timer.current); if (!suppressed.current && !menu) timer.current = setTimeout(() => setPreview(true), 450); };
  const hide = () => { clearTimeout(timer.current); setPreview(false); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPreview(false), 120); };
  const close = () => { suppressed.current = true; hide(); setMenu(undefined); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { clearTimeout(timer.current); setPreview(false); setMenu(undefined); }, [dismissSignal]);
  return <div ref={setAnchor} className="agsdl-block-anchor"
    onMouseEnter={show} onMouseLeave={() => { leave(); suppressed.current = false; }}
    onFocus={show} onBlur={() => { hide(); suppressed.current = false; }}
    onClickCapture={() => { suppressed.current = true; hide(); }}
    onContextMenu={event => {
      event.preventDefault(); event.stopPropagation(); hide(); suppressed.current = true;
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu(event.clientX || event.clientY ? { left: event.clientX, top: event.clientY } : { left: rect.left, top: rect.bottom });
    }}
    onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation(); hide(); suppressed.current = true;
      const rect = event.currentTarget.getBoundingClientRect(); setMenu({ left: rect.left, top: rect.bottom });
    }}>
    {cloneElement(children, { "aria-describedby": preview ? id : undefined })}
    {preview && !menu && anchor && <WorkflowGraphPopup anchor={anchor} id={id} label={title} onClose={close} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>
      <header><WorkflowStatusBadge task={task} native={native} /><div><small>{kindLabel}</small><strong>{title}</strong></div></header>
      <WorkflowBlockSummary card={card} incoming={incoming} outgoing={outgoing} />
    </WorkflowGraphPopup>}
    {menu && anchor && <WorkflowGraphPopup anchor={anchor} position={menu} label={title} actions={actions} onClose={close} />}
  </div>;
}
