"use client";

import React, { memo, useState } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import type { PrepNodeData } from "@/lib/plan-to-graph";
import {
  Database,
  Filter,
  GitMerge,
  BarChart3,
  Trash2,
  CopyX,
  Columns,
  FileOutput,
  Tag,
  Layers,
  Calculator,
  Plus,
  Sigma,
} from "lucide-react";

interface StepStyleConfig {
  headerBg: string;
  headerText: string;
  badgeBg: string;
  badgeText: string;
  borderColor: string;
  category: "input" | "clean" | "aggregate" | "join" | "union" | "output";
}

function getTableauStyle(type: string): StepStyleConfig {
  switch (type) {
    case "source":
      return {
        headerBg: "bg-blue-600",
        headerText: "text-white",
        badgeBg: "bg-blue-50 text-blue-700 border-blue-200",
        badgeText: "text-blue-700",
        borderColor: "border-blue-500",
        category: "input",
      };
    case "aggregate":
      return {
        headerBg: "bg-orange-500",
        headerText: "text-white",
        badgeBg: "bg-orange-50 text-orange-700 border-orange-200",
        badgeText: "text-orange-700",
        borderColor: "border-orange-500",
        category: "aggregate",
      };
    case "join":
      return {
        headerBg: "bg-purple-600",
        headerText: "text-white",
        badgeBg: "bg-purple-50 text-purple-700 border-purple-200",
        badgeText: "text-purple-700",
        borderColor: "border-purple-500",
        category: "join",
      };
    case "union":
      return {
        headerBg: "bg-amber-500",
        headerText: "text-white",
        badgeBg: "bg-amber-50 text-amber-800 border-amber-200",
        badgeText: "text-amber-800",
        borderColor: "border-amber-500",
        category: "union",
      };
    case "output":
      return {
        headerBg: "bg-slate-900",
        headerText: "text-white",
        badgeBg: "bg-slate-100 text-slate-800 border-slate-300",
        badgeText: "text-slate-800",
        borderColor: "border-slate-800",
        category: "output",
      };
    case "filter":
    case "calculate":
    case "rename":
    case "cast":
    case "text_clean":
    case "drop_nulls":
    case "dedupe":
    case "select_columns":
    default:
      // Clean Steps (Tableau Prep Signature Teal)
      return {
        headerBg: "bg-teal-600",
        headerText: "text-white",
        badgeBg: "bg-teal-50 text-teal-700 border-teal-200",
        badgeText: "text-teal-700",
        borderColor: "border-teal-500",
        category: "clean",
      };
  }
}

function getTableauIcon(type: string) {
  switch (type) {
    case "source":
      return <Database className="w-4 h-4 text-white" />;
    case "aggregate":
      return <Sigma className="w-4 h-4 text-white font-bold" />;
    case "join":
      return <GitMerge className="w-4 h-4 text-white" />;
    case "union":
      return <Layers className="w-4 h-4 text-white" />;
    case "calculate":
      return <Calculator className="w-4 h-4 text-white" />;
    case "filter":
      return <Filter className="w-4 h-4 text-white" />;
    case "output":
      return <FileOutput className="w-4 h-4 text-white" />;
    case "rename":
    case "cast":
      return <Tag className="w-4 h-4 text-white" />;
    case "dedupe":
      return <CopyX className="w-4 h-4 text-white" />;
    case "drop_nulls":
      return <Trash2 className="w-4 h-4 text-white" />;
    case "select_columns":
    case "text_clean":
    default:
      return <Columns className="w-4 h-4 text-white" />;
  }
}

function PrepStepNodeComponent({ data, selected }: NodeProps) {
  const nodeData = data as unknown as PrepNodeData;
  const isSource = nodeData.type === "source";
  const isOutput = nodeData.type === "output";
  const style = getTableauStyle(nodeData.type);
  const [showAddMenu, setShowAddMenu] = useState(false);

  const changesCount = nodeData.changesCount ?? 1;

  return (
    <div className="relative group">
      <div
        className={`w-[220px] bg-white rounded-lg shadow-sm border transition-all duration-200 cursor-pointer overflow-hidden ${
          selected
            ? "ring-2 ring-blue-500 border-blue-600 shadow-md"
            : "border-slate-200 hover:border-slate-400 hover:shadow-md"
        }`}
      >
        {/* Target handle (left) - for input connections */}
        {!isSource && (
          <Handle
            type="target"
            position={Position.Left}
            className="w-2.5 h-2.5 bg-slate-400 border border-white hover:scale-125 transition-transform"
          />
        )}

        {/* Tableau Style Header Bar */}
        <div className={`px-3 py-2 ${style.headerBg} flex items-center justify-between`}>
          <div className="flex items-center gap-2 min-w-0">
            {getTableauIcon(nodeData.type)}
            <span className="text-[12px] font-bold tracking-wide truncate capitalize text-white">
              {style.category === "clean" ? "Clean Step" : nodeData.type}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {style.category === "clean" && (
              <span className="text-[10px] font-bold bg-white/20 text-white px-1.5 py-0.5 rounded-full">
                {changesCount} {changesCount === 1 ? "change" : "changes"}
              </span>
            )}
            {nodeData.onDeleteStep && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  nodeData.onDeleteStep?.(nodeData.alias);
                }}
                title="Delete this step"
                className="p-1 rounded text-white/70 hover:text-white hover:bg-white/20 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Node Body */}
        <div className="p-3 bg-white">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-xs font-bold text-slate-800 truncate" title={nodeData.label}>
              {nodeData.label}
            </h4>
            <span
              className={`text-[9px] font-mono px-1 py-0.2 rounded border ${style.badgeBg}`}
            >
              {nodeData.alias}
            </span>
          </div>

          <p className="text-[11px] text-slate-500 line-clamp-2 leading-relaxed" title={nodeData.description}>
            {nodeData.description || "Transformation step"}
          </p>
        </div>

        {/* Source handle (right) - for downstream connection */}
        {!isOutput && (
          <Handle
            type="source"
            position={Position.Right}
            className="w-2.5 h-2.5 bg-slate-400 border border-white hover:scale-125 transition-transform"
          />
        )}
      </div>

      {/* Tableau Prep Style Hover "+" Step Insertion Button */}
      {!isOutput && (
        <div className="absolute right-[-14px] top-1/2 -translate-y-1/2 z-30 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowAddMenu((prev) => !prev);
            }}
            title="Add a step"
            className="w-6 h-6 rounded-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center shadow-md border-2 border-white cursor-pointer hover:scale-110 transition-all"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
          </button>

          {/* Quick Step Menu Popover */}
          {showAddMenu && (
            <div
              className="absolute left-8 top-1/2 -translate-y-1/2 w-48 bg-white rounded-lg shadow-xl border border-slate-200 py-1.5 z-50 text-xs animate-in fade-in zoom-in-95 duration-150"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 mb-1">
                Insert Step
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAddMenu(false);
                  nodeData.onAddStep?.(nodeData.alias, "clean");
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-teal-50 hover:text-teal-700 flex items-center gap-2 text-slate-700 cursor-pointer"
              >
                <div className="w-4 h-4 rounded bg-teal-600 text-white flex items-center justify-center text-[10px]">
                  <Filter className="w-2.5 h-2.5" />
                </div>
                <span>Clean Step</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddMenu(false);
                  nodeData.onAddStep?.(nodeData.alias, "aggregate");
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-orange-50 hover:text-orange-700 flex items-center gap-2 text-slate-700 cursor-pointer"
              >
                <div className="w-4 h-4 rounded bg-orange-500 text-white flex items-center justify-center text-[10px]">
                  <Sigma className="w-2.5 h-2.5" />
                </div>
                <span>Aggregate</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddMenu(false);
                  nodeData.onAddStep?.(nodeData.alias, "join");
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-purple-50 hover:text-purple-700 flex items-center gap-2 text-slate-700 cursor-pointer"
              >
                <div className="w-4 h-4 rounded bg-purple-600 text-white flex items-center justify-center text-[10px]">
                  <GitMerge className="w-2.5 h-2.5" />
                </div>
                <span>Join</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddMenu(false);
                  nodeData.onAddStep?.(nodeData.alias, "output");
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100 hover:text-slate-900 flex items-center gap-2 text-slate-700 cursor-pointer border-t border-slate-100 mt-1"
              >
                <div className="w-4 h-4 rounded bg-slate-900 text-white flex items-center justify-center text-[10px]">
                  <FileOutput className="w-2.5 h-2.5" />
                </div>
                <span>Output</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const PrepStepNode = memo(PrepStepNodeComponent);
