import { useEffect, useId, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { ArrowDown, ArrowDownToLine, ArrowRightLeft, Check, CornerUpLeft, GitBranch, Info, Link2, X } from 'lucide-react';
import type { ViewerEdge, ViewerEdgeRoute } from '../../services/agsdl/graphLayout';
import { viewerEdgePath } from '../../services/agsdl/graphLayout';
import { WorkflowGraphPopup } from './WorkflowGraphPopup';
import { WorkflowEdgePreview } from './WorkflowPreviews';
import { useAgsdlTranslation } from './useAgsdlTranslation';

export type WorkflowEdgeData = {
  route?: ViewerEdgeRoute;
  /** The target's agent is shared by several steps, so the message may wait in its queue. */
  queued?: boolean;
  connection: ViewerEdge;
  sourceTitle: string;
  targetTitle: string;
  sourcePerformer?: string;
  dismissSignal: number;
  focusEdge?: (id: string, open: boolean) => void;
  inspect?: () => void;
  inspectSource: () => void;
  inspectTarget: () => void;
};
export type GraphEdge = Edge<WorkflowEdgeData, 'workflow'>;
const QUEUE_GAP = 8;

const namedRouteKey = (route: string) => ['true', 'false', 'approved', 'denied', 'onError'].includes(route) ? `agsdl.link.${route}` : 'agsdl.link.branch';
const routeKey = (edge: ViewerEdge) => !['next', 'success', 'exchange', 'dependency', ''].includes(edge.label) ? edge.label : undefined;
function edgeSymbol(edge: ViewerEdge, size: number) {
  const props = { size, 'aria-hidden': true as const };
  switch (routeKey(edge)) {
    case 'true': case 'approved': return <Check {...props} />;
    case 'false': case 'denied': return <X {...props} />;
    case 'onError': return <CornerUpLeft {...props} />;
    case undefined: return edge.exchangeOnly || edge.transfers?.length ? <ArrowRightLeft {...props} /> : edge.dependency ? <Link2 {...props} /> : <ArrowDown {...props} />;
    default: return <GitBranch {...props} />;
  }
}
// These are the exact delivery projections emitted by viewer020, not parsed identifiers.
const transferKeys: Record<string, string> = {
  'Message': 'message', 'completion': 'response', 'data': 'result', 'members': 'results', 'error': 'error', 'current value': 'value',
  'resources.result ← text · text/plain': 'response', 'resources.result ← data · application/json': 'result',
  'resources.result ← members · application/json': 'results', 'resources.error ← error · application/json': 'error',
};

export function WorkflowEdgeSummary({ connection: edge, sourceTitle, targetTitle, onSource, onTarget }: Pick<WorkflowEdgeData, 'connection' | 'sourceTitle' | 'targetTitle'> & { onSource?: () => void; onTarget?: () => void }) {
  const { t } = useAgsdlTranslation();
  const route = routeKey(edge);
  const heading = route ? t(namedRouteKey(route), { name: edge.label })
    : t(`agsdl.link.${edge.exchangeOnly ? 'exchange' : edge.dependency ? 'dependency' : 'sequence'}`);
  const transfers = [...new Set((edge.transfers ?? []).map(name => transferKeys[name] ? t(`agsdl.link.payload.${transferKeys[name]}`) : t(`agsdl.edge.${name}`, { defaultValue: name })))];
  return <div className="agsdl-edge-summary">
    <header>{edgeSymbol(edge, 15)}<strong>{heading}</strong></header>
    <div className="agsdl-edge-endpoints">
      {onSource ? <button type="button" onClick={onSource}>{sourceTitle}</button> : <span>{sourceTitle}</span>}
      <ArrowDown size={13} aria-hidden="true" />
      {onTarget ? <button type="button" onClick={onTarget}>{targetTitle}</button> : <strong>{targetTitle}</strong>}
    </div>
    {transfers.length > 0 && <section><small>{t('agsdl.link.payloadTitle')}</small><div className="agsdl-edge-payloads">{transfers.map(name => <span key={name}>{name}</span>)}</div></section>}
    {edge.exchangeOnly && <p className="agsdl-edge-note">{t('agsdl.link.exchangeHint')}</p>}
    {edge.dependency && <p className="agsdl-edge-note">{t('agsdl.link.dependencyHint')}</p>}
  </div>;
}

/** Read-only connection inspection shared by Architect and Operate. */
export function WorkflowEdge(props: EdgeProps<GraphEdge>) {
  const { t } = useAgsdlTranslation();
  const data = props.data!;
  const route = data.route;
  const failure = data.connection.label === 'onError';
  const steering = data.connection.label === 'steers';
  // A queued arrival stops short of the block, leaving room for its queue notch.
  const handles = data.queued ? { ...props, targetY: props.targetY - QUEUE_GAP } : props;
  const path = route ? viewerEdgePath(route, handles, failure) : getSmoothStepPath(handles)[0];
  const stroke = props.style?.stroke as string | undefined;
  const [anchor, setAnchor] = useState<SVGGElement | null>(null);
  const pointerPosition = useRef<{ left: number; top: number } | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinned = useRef(false);
  const suppressed = useRef(false);
  const id = useId();
  const close = () => { suppressed.current = true; clearTimeout(timer.current); pinned.current = false; setPreview(false); setMenu(undefined); };
  const place = () => {
    const rect = anchor?.getBoundingClientRect();
    setPosition(pointerPosition.current ?? (rect ? { left: rect.left + rect.width / 2 + 12, top: rect.top + rect.height / 2 } : undefined));
  };
  const show = () => { clearTimeout(timer.current); if (!menu && !suppressed.current) timer.current = setTimeout(() => { place(); setPreview(true); }, 400); };
  const leave = () => { suppressed.current = false; clearTimeout(timer.current); if (!pinned.current) timer.current = setTimeout(() => setPreview(false), 140); };
  const pin = () => { clearTimeout(timer.current); pinned.current = true; place(); setPreview(true); };
  const focusEdge = data.focusEdge;
  useEffect(() => {
    focusEdge?.(props.id, preview || Boolean(menu));
    return () => focusEdge?.(props.id, false);
  }, [focusEdge, props.id, preview, menu]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { clearTimeout(timer.current); pinned.current = false; setPreview(false); setMenu(undefined); }, [data.dismissSignal]);
  return <>
    <g ref={setAnchor} className="agsdl-edge-hit" role="button" tabIndex={0} aria-label={`${routeKey(data.connection) ? t(namedRouteKey(routeKey(data.connection)!), { name: data.connection.label }) : t(`agsdl.link.${data.connection.exchangeOnly ? "exchange" : data.connection.dependency ? "dependency" : "sequence"}`)} · ${data.sourceTitle} → ${data.targetTitle}`} aria-describedby={preview ? id : undefined}
      onMouseEnter={event => { pointerPosition.current = { left: event.clientX + 12, top: event.clientY + 12 }; show(); }} onMouseLeave={leave}
      onFocus={() => { pointerPosition.current = undefined; show(); }} onBlur={() => { suppressed.current = false; if (!menu) { clearTimeout(timer.current); if (!pinned.current) setPreview(false); } }}
      onClick={event => { event.stopPropagation(); pin(); }}
      onDoubleClick={event => { event.stopPropagation(); if (data.inspect) { close(); data.inspect(); } }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); close(); setMenu({ left: event.clientX, top: event.clientY }); }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); pin(); }
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault(); event.stopPropagation(); close();
          const rect = anchor?.getBoundingClientRect(); setMenu({ left: rect ? rect.left + rect.width / 2 : 0, top: rect ? rect.top + rect.height / 2 : 0 });
        }
      }}>
      <BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} interactionWidth={18} />
      {data.queued && <path className="agsdl-edge-queue" d={`M${props.targetX - 6} ${props.targetY - 5.5}H${props.targetX + 6}M${props.targetX - 6} ${props.targetY - 2.5}H${props.targetX + 6}`} style={{ stroke, opacity: props.style?.opacity }} />}
    </g>
    {/* A steering message lands on the side of the block that is working. */}
    {steering && <EdgeLabelRenderer>
      <svg className="agsdl-edge-landing is-origin" width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"
        style={{ transform: `translate(-50%, -50%) translate(${props.sourceX}px, ${props.sourceY}px)`, opacity: props.style?.opacity, fill: stroke }}>
        <circle r="2.5" />
      </svg>
      <svg className="agsdl-edge-landing" width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"
        style={{ transform: `translate(-50%, -50%) translate(${props.targetX}px, ${props.targetY}px)`, opacity: props.style?.opacity, stroke }}>
        <circle r="3.5" />
      </svg>
    </EdgeLabelRenderer>}
    {/* Drawn above the blocks: the exit sits on the block's border. */}
    {failure && <EdgeLabelRenderer><svg className="agsdl-edge-exit" width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"
      style={{ transform: `translate(-50%, -50%) translate(${props.sourceX}px, ${props.sourceY}px)`, opacity: props.style?.opacity }}>
      <circle r="8" /><path d="M0 -3.5v4M0 3.4v.1" />
    </svg></EdgeLabelRenderer>}
    {preview && !menu && anchor && <WorkflowGraphPopup anchor={anchor} position={position} id={id} label={t('agsdl.viewer.connection')} onClose={close}
      onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>
      <WorkflowEdgePreview connection={data.connection} sourceTitle={data.sourceTitle} sourcePerformer={data.sourcePerformer} />
    </WorkflowGraphPopup>}
    {menu && anchor && <WorkflowGraphPopup anchor={anchor} position={menu} label={t('agsdl.viewer.connection')} onClose={close} actions={[
      { label: t('agsdl.link.source'), icon: <Info size={14} />, run: data.inspectSource },
      { label: t('agsdl.link.target'), icon: <ArrowDownToLine size={14} />, run: data.inspectTarget },
    ]} />}
  </>;
}
