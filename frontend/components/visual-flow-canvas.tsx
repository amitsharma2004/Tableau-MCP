"use client";

import React, { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  Connection as FlowConnection,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PlanDraft } from "@/lib/types";
import { planToFlowGraph, backendFlowToGraph, PrepNodeData, BackendFlow } from "@/lib/plan-to-graph";
import { PrepStepNode } from "@/components/prep-step-node";
import { PrepFlowEdge } from "@/components/prep-flow-edge";

const ZOOM_LEVELS = [1.0, 1.25, 1.5] as const;

function ZoomControls() {
  const { zoomTo, getZoom } = useReactFlow();
  const [activeZoom, setActiveZoom] = useState<number>(1.0);

  function handleZoom(level: number) {
    zoomTo(level, { duration: 250 });
    setActiveZoom(level);
  }

  return (
    <Panel position="bottom-right">
      <div className="flex items-center gap-0.5 bg-white border border-slate-200 shadow-sm rounded-lg p-1 mb-1 mr-1">
        {ZOOM_LEVELS.map((level) => (
          <button
            key={level}
            onClick={() => handleZoom(level)}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
              activeZoom === level
                ? "bg-blue-600 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {level === 1.0 ? "1×" : `${level}×`}
          </button>
        ))}
      </div>
    </Panel>
  );
}

const nodeTypes = {
  prepStep: PrepStepNode,
};

const edgeTypes = {
  prepEdge: PrepFlowEdge,
};

export interface VisualFlowCanvasProps {
  plan?: PlanDraft;
  backendFlow?: BackendFlow;
  nodePositions?: Record<string, { x: number; y: number }>;
  onNodeSelect?: (nodeData: PrepNodeData | null) => void;
  onTableDrop?: (tableName: string) => void;
  onConnectNodes?: (sourceAlias: string, targetAlias: string) => void;
  onAddStepOnEdge?: (sourceAlias: string, targetAlias: string) => void;
  onAddStepFromNode?: (sourceAlias: string, stepType?: string) => void;
  onDeleteStep?: (alias: string) => void;
  onPositionsChange?: (positions: Record<string, { x: number; y: number }>) => void;
  className?: string;
}

export function VisualFlowCanvas({
  plan,
  backendFlow,
  nodePositions,
  onNodeSelect,
  onTableDrop,
  onConnectNodes,
  onAddStepOnEdge,
  onAddStepFromNode,
  onDeleteStep,
  onPositionsChange,
  className = "h-[440px]",
}: VisualFlowCanvasProps) {
  const { initialNodes, initialEdges } = useMemo(() => {
    const { nodes, edges } = backendFlow
      ? backendFlowToGraph(backendFlow, nodePositions)
      : planToFlowGraph(plan!);
    // Inject onDeleteStep and onAddStep handler into intermediate step nodes
    const nodesWithHandler = nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        onDeleteStep: onDeleteStep ? (alias: string) => onDeleteStep(alias) : undefined,
        onAddStep: (src: string, stepType?: string) => onAddStepFromNode?.(src, stepType),
      },
    }));
    // Inject onAddStep handler into custom edges
    const edgesWithHandler = edges.map((e) => ({
      ...e,
      data: {
        ...(e.data || {}),
        onAddStep: (src: string, tgt: string) => onAddStepOnEdge?.(src, tgt),
      },
    }));
    return { initialNodes: nodesWithHandler, initialEdges: edgesWithHandler };
  }, [plan, onAddStepOnEdge, onAddStepFromNode, onDeleteStep]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragEndedRef = React.useRef(false);

  React.useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Emit positions after a drag ends — runs after render, never during it
  React.useEffect(() => {
    if (dragEndedRef.current && onPositionsChange) {
      dragEndedRef.current = false;
      const pos: Record<string, { x: number; y: number }> = {};
      nodes.forEach((n) => { pos[n.id] = n.position; });
      onPositionsChange(pos);
    }
  }, [nodes, onPositionsChange]);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);
      if (changes.some((c) => c.type === "position" && !c.dragging)) {
        dragEndedRef.current = true;
      }
    },
    [onNodesChange]
  );

  // Handle Edge Connection drag from one table/step node to another
  const handleConnect = useCallback(
    (connection: FlowConnection) => {
      if (!connection.source || !connection.target) return;
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return;

      const sourceAlias = (sourceNode.data as PrepNodeData).alias;
      const targetAlias = (targetNode.data as PrepNodeData).alias;

      if (sourceAlias && targetAlias && sourceAlias !== targetAlias) {
        onConnectNodes?.(sourceAlias, targetAlias);
      }
    },
    [nodes, onConnectNodes]
  );

  // Drag and Drop handlers for dropping tables from sidebar onto canvas
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const tableName = e.dataTransfer.getData("application/tableau-table");
      if (tableName && onTableDrop) {
        onTableDrop(tableName);
      }
    },
    [onTableDrop]
  );

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`w-full bg-slate-50 border rounded-xl relative overflow-hidden shadow-inner transition-colors ${
        isDragOver ? "border-blue-500 ring-2 ring-blue-300 bg-blue-50/20" : "border-slate-200"
      } ${className}`}
    >
      <div className="absolute top-3 left-4 z-10 bg-white/90 backdrop-blur border border-slate-200 px-3 py-1.5 rounded-md shadow-sm flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-700">Tableau Prep Workflow Canvas</span>
        <span className="text-[11px] text-slate-500">({nodes.length} nodes)</span>
        {isDragOver && (
          <span className="text-[11px] font-bold text-blue-600 animate-pulse ml-2">
            Drop table here to add to flow!
          </span>
        )}
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => onNodeSelect?.(node.data as PrepNodeData)}
        onPaneClick={() => onNodeSelect?.(null)}
        defaultViewport={{ x: 60, y: 60, zoom: 1.0 }}
        minZoom={1.0}
        maxZoom={1.5}
        snapToGrid
        snapGrid={[20, 20]}
        attributionPosition="bottom-right"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5e1" />
        <ZoomControls />
      </ReactFlow>
    </div>
  );
}
