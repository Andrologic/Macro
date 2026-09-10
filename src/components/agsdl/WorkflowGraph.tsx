import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from "react";
import { Background, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Bot, Boxes, CircleHelp, GitBranch, Hand, LogIn, LogOut, LocateFixed, Minus, Plus, Wrench, Database } from "lucide-react";
import { useElementSize } from "../../hooks/useElementSize";
import { layoutViewer, type ViewerEdge } from "../../services/agsdl/graphLayout";
import type { ViewerCard } from "../../services/agsdl/viewer";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "@xyflow/react/dist/style.css";

type GraphNode = Node<{
  card: ViewerCard;
  title: string;
  kindLabel: string;
  active: boolean;
  subtitle: string;
  select: (path: string) => void;
}, "workflow">;

function WorkflowNode({ data }: NodeProps<GraphNode>) {
  const { card } = data;
  const { t } = useAgsdlTranslation();
  const Icon = card.kind === "System" ? Boxes : card.kind === "condition" ? GitBranch : card.kind === "approval" ? Hand : Bot;
  const warning = card.unresolved || card.branches.some(branch => branch.reference.unresolved) || card.dependencies?.some(ref => ref.unresolved);
  const label = [data.kindLabel, data.title !== data.kindLabel ? data.title : "", data.subtitle, warning ? t("agsdl.viewer.unresolved") : ""].filter(Boolean).join(" · ");
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <button
        className={`agsdl-graph-node nodrag${data.active ? " is-selected" : ""}${card.kind === "approval" ? " is-interaction" : ""}`}
        onClick={() => data.select(data.active ? "" : card.path)}
        aria-pressed={data.active}
        title={label}
      >
        <span className="agsdl-node-icon"><Icon size={15} aria-hidden="true" /></span>
        <span className="agsdl-node-text">
          <span className="agsdl-node-title">{data.title}</span>
          {data.subtitle && <span className="agsdl-node-subtitle">{data.subtitle}</span>}
        </span>
        <span className="agsdl-node-capabilities">
          {card.inputs.length > 0 && <LogIn size={12} aria-label={t("agsdl.viewer.inputs")} />}
          {card.outputs.length > 0 && <LogOut size={12} aria-label={t("agsdl.viewer.outputs")} />}
          {!!card.tools?.length && <Wrench size={12} aria-label={t("agsdl.agentTools")} />}
          {!!card.resources?.length && <Database size={12} aria-label={t("agsdl.viewer.resources")} />}
        </span>
        {warning && <CircleHelp size={12} className="agsdl-node-warning" aria-hidden="true" />}
      </button>
      <Handle type="source" position={Position.Bottom} id="out" />
    </>
  );
}
const nodeTypes = { workflow: WorkflowNode };
const fitOptions = { padding: 0.16, minZoom: 0.5, maxZoom: 1 };

function Canvas({ cards, edges: connections, selected, select, title }: {
  cards: ViewerCard[];
  edges: ViewerEdge[];
  selected: string;
  select: (path: string) => void;
  title: (card: ViewerCard) => string;
}) {
  const { t } = useAgsdlTranslation();
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const flow = useReactFlow<GraphNode>();
  const backgroundId = useId();
  const layout = useMemo(() => layoutViewer(cards, connections), [cards, connections]);
  const topology = JSON.stringify(layout.nodes.map(node => [node.card.path, node.position]));
  const fitted = useRef("");
  useEffect(() => {
    if (!width || !height) return;
    const timer = setTimeout(() => {
      const fitKey = `${width}:${topology}`;
      if (fitted.current !== fitKey) {
        fitted.current = fitKey;
        void flow.fitView(fitOptions);
        return;
      }
      // Opening details must preserve the user's zoom. Pan only if the selected
      // node would be obscured by the inspector or the canvas controls.
      const node = flow.getNode(selected);
      const viewport = flow.getViewport();
      const allNodes = flow.getNodes();
      if (!allNodes.length) return;
      const graphTop = Math.min(...allNodes.map(item => item.position.y));
      const graphBottom = Math.max(...allNodes.map(item => item.position.y + (item.measured?.height ?? 68)));
      const canShowAll = (graphBottom - graphTop) * viewport.zoom <= height - 70;
      if (!node && !canShowAll) {
        void flow.fitView(fitOptions);
        return;
      }
      const top = (canShowAll ? graphTop : node!.position.y) * viewport.zoom + viewport.y;
      const bottom = (canShowAll ? graphBottom : node!.position.y + (node!.measured?.height ?? 68)) * viewport.zoom + viewport.y;
      const offset = top < 20 ? 20 - top : bottom > height - 50 ? height - 50 - bottom : 0;
      if (offset) void flow.setViewport({ ...viewport, y: viewport.y + offset });
    }, 80);
    return () => clearTimeout(timer);
  }, [width, height, topology, flow, selected]);
  const nodes: GraphNode[] = layout.nodes.map(({ card, position }) => ({
    id: card.path, type: "workflow", position,
    style: { width: 210, height: card.kind === "approval" ? 68 : 52 },
    data: { card, title: title(card), kindLabel: t(`agsdl.kind.${card.kind}`, { defaultValue: card.kind }), active: selected === card.path,
      subtitle: card.kind === "approval" ? card.approvers?.length ? card.approvers.map(ref => ref.label).join(" · ") : t("agsdl.viewer.approverMissing") : "",
      select },
  }));
  const edges = layout.edges.filter(edge => !edge.exchangeOnly).map(edge => {
    const color = edge.dependency ? "rgb(var(--muted-foreground))" : "rgb(var(--primary))";
    const transfer = edge.transfers?.join(", ");
    const condition = edge.label === "true" ? t("agsdl.edge.true") : edge.label === "false" ? t("agsdl.edge.false") : undefined;
    return {
      ...edge, type: "smoothstep",
      sourceHandle: "out",
      targetHandle: "in",
      label: undefined,
      ariaRole: "button" as const,
      domAttributes: {
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            select(selected === edge.id ? "" : edge.id);
          }
        },
      },
      ariaLabel: `${title(cards.find(card => card.path === edge.source)!)} → ${title(cards.find(card => card.path === edge.target)!)}${transfer ? ` · ${transfer}` : ""}${condition ? ` · ${condition}` : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: selected === edge.id ? 2.5 : 1.3, strokeDasharray: edge.dependency ? "4 4" : undefined, opacity: 0.8 },
    };
  });
  return (
    <div ref={ref} className="agsdl-canvas" onKeyDown={event => { if (event.key === "Escape") select(""); }}>
      <ReactFlow<GraphNode>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
        edgesFocusable={true} edgesReconnectable={false} elementsSelectable={false}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        onEdgeClick={(_, edge) => select(selected === edge.id ? "" : edge.id)}
        onPaneClick={() => select("")} fitView fitViewOptions={fitOptions}
        minZoom={0.3} maxZoom={1.8} zoomOnDoubleClick={false}
      >
        <Background id={backgroundId} color="rgb(var(--muted-foreground) / 0.3)" gap={20} size={1.5} />
        <Panel position="bottom-left" className="agsdl-graph-controls">
          <button onClick={() => void flow.zoomOut()} aria-label={t("agsdl.viewer.zoomOut")} title={t("agsdl.viewer.zoomOut")}><Minus size={14} /></button>
          <button onClick={() => void flow.zoomIn()} aria-label={t("agsdl.viewer.zoomIn")} title={t("agsdl.viewer.zoomIn")}><Plus size={14} /></button>
          <button onClick={() => void flow.fitView(fitOptions)} aria-label={t("agsdl.viewer.fit")} title={t("agsdl.viewer.fit")}><LocateFixed size={14} /></button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
export function WorkflowGraph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
