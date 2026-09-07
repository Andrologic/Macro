import React, { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Connection,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import type { AgsdlGraphEdge, AgsdlGraphNode } from "../../types/agsdl";
import "@xyflow/react/dist/style.css";
import "./agsdl.css";

type CanvasNode = Node<{
  item: AgsdlGraphNode;
  problem: boolean;
  label: string;
}>;
const GraphNode: React.FC<NodeProps<CanvasNode>> = ({ data, selected }) => {
  const { t } = useAgsdlTranslation();
  const horizontal =
    data.item.outputs.includes("relation") || data.item.external;
  return (
    <div
      className={`agsdl-node ${selected ? "agsdl-node-selected" : ""} ${data.problem ? "agsdl-node-problem" : ""}`}
    >
      <Handle
        type="target"
        position={horizontal ? Position.Left : Position.Top}
        isConnectable={!data.item.external}
      />
      <div className="agsdl-node-kind">{data.label}</div>
      <div className="agsdl-node-title">{data.item.title}</div>
      <div className="agsdl-node-subtitle">{data.item.subtitle}</div>
      {horizontal
        ? data.item.outputs.length > 0 && (
            <Handle type="source" id="relation" position={Position.Right} />
          )
        : data.item.outputs.length > 0 && (
            <div className="agsdl-node-ports">
              {data.item.outputs.map((output, index) => (
                <span key={output}>
                  {t(`agsdl.edge.${output}`, { defaultValue: output })}
                  <Handle
                    type="source"
                    id={output}
                    position={Position.Bottom}
                    style={{
                      left: `${((index + 1) / (data.item.outputs.length + 1)) * 100}%`,
                    }}
                  />
                </span>
              ))}
            </div>
          )}
    </div>
  );
};

const nodeTypes = { agsdl: GraphNode };

export interface AgsdlCanvasProps {
  nodes: AgsdlGraphNode[];
  edges: AgsdlGraphEdge[];
  selected: string;
  problemPaths: string[];
  readOnly: boolean;
  onSelect: (path: string) => void;
  onConnect: (connection: Connection) => void;
  onSelectEdge: (path: string) => void;
}

export const AgsdlCanvas: React.FC<AgsdlCanvasProps> = ({
  nodes: projectedNodes,
  edges: projectedEdges,
  selected,
  problemPaths,
  readOnly,
  onSelect,
  onConnect,
  onSelectEdge,
}) => {
  const { t } = useAgsdlTranslation();
  const incoming = useMemo<CanvasNode[]>(
    () =>
      projectedNodes.map((item) => ({
        id: item.id,
        type: "agsdl",
        position: item.position,
        selected: item.path === selected,
        data: {
          item,
          label: t(`agsdl.kind.${item.kind}`, { defaultValue: item.kind }),
          problem: problemPaths.some(
            (path) => path === item.path || path.startsWith(`${item.path}/`),
          ),
        },
      })),
    [projectedNodes, selected, problemPaths, t],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(incoming);
  useEffect(
    () =>
      setNodes((previous) =>
        incoming.map((node) => ({
          ...node,
          position:
            previous.find((item) => item.id === node.id)?.position ??
            node.position,
        })),
      ),
    [incoming, setNodes],
  );
  const edges = useMemo(
    () =>
      projectedEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.handle,
        label: t(`agsdl.edge.${edge.label}`, { defaultValue: edge.label }),
        data: { path: edge.path },
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: "rgb(var(--muted-foreground))" },
        labelStyle: { fill: "rgb(var(--foreground))", fontSize: 11 },
        labelBgStyle: { fill: "rgb(var(--background))" },
      })),
    [projectedEdges, t],
  );
  return (
    <div className="agsdl-canvas" aria-label={t("agsdl.graph")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => onSelect(node.data.item.path)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.data!.path)}
        onConnect={onConnect}
        nodesConnectable={!readOnly}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.8}
        onlyRenderVisibleElements
      >
        <Background color="rgb(var(--border))" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
