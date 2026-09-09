import { useEffect, useMemo } from "react";
import { Background, Handle, MarkerType, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { Bot, CircleHelp, GitBranch, Hand, LogIn, LogOut, Maximize2, Minus, Plus } from "lucide-react";
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
  const Icon = card.kind === "input" ? LogIn : card.kind === "output" ? LogOut
    : card.kind === "condition" ? GitBranch : card.kind === "approval" ? Hand : Bot;
  const warning = card.unresolved || card.branches.some(branch => branch.reference.unresolved) || card.dependencies?.some(ref => ref.unresolved);
  return (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="target" position={Position.Left} id="side-in" />
      <button
        className={`agsdl-graph-node nodrag${data.active ? " is-selected" : ""}${["input", "output"].includes(card.kind) ? " is-boundary" : ""}${card.kind === "approval" ? " is-interaction" : ""}`}
        onClick={() => data.select(data.active ? "" : card.path)}
        aria-pressed={data.active}
        title={`${data.kindLabel} · ${data.title}${data.subtitle ? ` · ${data.subtitle}` : ""}${warning ? ` · ${t("agsdl.viewer.unresolved")}` : ""}`}
      >
        <span className="agsdl-node-icon"><Icon size={15} /></span>
        <span className="agsdl-node-text"><span className="agsdl-node-title">{data.title}</span>{data.subtitle && <span className="agsdl-node-subtitle">{data.subtitle}</span>}</span>
        {warning && <CircleHelp size={12} className="agsdl-node-warning" aria-hidden="true" />}
      </button>
      <Handle type="source" position={Position.Bottom} id="out" />
      <Handle type="source" position={Position.Right} id="side-out" />
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
  const layout = useMemo(() => layoutViewer(cards, connections), [cards, connections]);
  const topology = JSON.stringify(layout.nodes.map(node => [node.card.path, node.position]));
  useEffect(() => {
    if (!width || !height) return;
    const timer = setTimeout(() => void flow.fitView(fitOptions), 80);
    return () => clearTimeout(timer);
  }, [width, height, topology, flow]);
  const nodes: GraphNode[] = layout.nodes.map(({ card, position }) => ({
    id: card.path, type: "workflow", position,
    style: { width: 210, height: ["input", "output", "approval"].includes(card.kind) ? 68 : 52 },
    data: { card, title: title(card), kindLabel: ["input", "output"].includes(card.kind) ? title(card) : t(`agsdl.kind.${card.kind}`, { defaultValue: card.kind }), active: selected === card.path,
      subtitle: card.kind === "input" ? card.inputs.map(port => port.name).join(" · ")
        : card.kind === "output" ? card.outputs.map(port => port.name).join(" · ")
        : card.kind === "approval" ? card.approvers?.length ? card.approvers.map(ref => ref.label).join(" · ") : t("agsdl.viewer.approverMissing") : "",
      select },
  }));
  const edges = layout.edges.filter(edge => !edge.exchangeOnly || edge.source === selected || edge.target === selected).map(edge => {
    const related = edge.source === selected || edge.target === selected;
    const color = edge.dependency || edge.exchangeOnly ? "rgb(var(--muted-foreground))" : "rgb(var(--primary))";
    const transfer = edge.transfers?.join(", ");
    const condition = edge.label === "true" ? t("agsdl.edge.true") : edge.label === "false" ? t("agsdl.edge.false") : undefined;
    return {
      ...edge, type: "smoothstep",
      sourceHandle: edge.exchangeOnly ? "side-out" : "out",
      targetHandle: edge.exchangeOnly ? "side-in" : "in",
      label: edge.label === "entry" || cards.find(card => card.path === edge.target)?.kind === "output" ? undefined
        : transfer ? (transfer.length > 32 ? `${transfer.slice(0, 29)}…` : transfer) : condition,
      ariaLabel: `${title(cards.find(card => card.path === edge.source)!)} → ${title(cards.find(card => card.path === edge.target)!)}${transfer ? ` · ${transfer}` : ""}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
      style: { stroke: color, strokeWidth: related ? 2 : 1.3, strokeDasharray: edge.exchangeOnly || edge.dependency ? "4 4" : undefined, opacity: selected && !related ? 0.25 : 0.8 },
      labelStyle: { fill: "rgb(var(--muted-foreground))", fontSize: 10 },
      labelBgStyle: { fill: "rgb(var(--background))" },
    };
  });
  return (
    <div ref={ref} className="agsdl-canvas" onKeyDown={event => { if (event.key === "Escape") select(""); }}>
      <ReactFlow<GraphNode>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        nodesDraggable={false} nodesConnectable={false} nodesFocusable={false}
        edgesFocusable={false} edgesReconnectable={false} elementsSelectable={false}
        deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        onPaneClick={() => select("")} fitView fitViewOptions={fitOptions}
        minZoom={0.3} maxZoom={1.8} zoomOnDoubleClick={false}
      >
        <Background color="rgb(var(--border))" gap={20} size={1} />
        <Panel position="bottom-left" className="agsdl-graph-controls">
          <button onClick={() => void flow.zoomOut()} aria-label={t("agsdl.viewer.zoomOut")} title={t("agsdl.viewer.zoomOut")}><Minus size={14} /></button>
          <button onClick={() => void flow.zoomIn()} aria-label={t("agsdl.viewer.zoomIn")} title={t("agsdl.viewer.zoomIn")}><Plus size={14} /></button>
          <button onClick={() => void flow.fitView(fitOptions)} aria-label={t("agsdl.viewer.fit")} title={t("agsdl.viewer.fit")}><Maximize2 size={14} /></button>
        </Panel>
      </ReactFlow>
    </div>
  );
}
export function WorkflowGraph(props: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
