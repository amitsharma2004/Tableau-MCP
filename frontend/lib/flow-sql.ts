/**
 * flow-sql.ts
 *
 * Builds a per-node JSON map from the canvas graph.
 * Each entry represents the sub-graph (nodes + edges) leading up to that node.
 * The backend /flows/compile-sql endpoint translates this to optimized SQL via Apache Calcite.
 *
 * Clean step sub-operation types are kept here because step-action-modal.tsx imports them.
 */

import type { BackendNode } from "./plan-to-graph";

export interface FlowEdge {
  from: string;
  to: string;
}

// ── Clean sub-operation types (used by step-action-modal) ─────────────────────

export interface RenameOp {
  op: "rename";
  mapping: Record<string, string>; // { old_col: new_col }
}

export interface FilterCondition {
  column: string;
  operator: string; // "=", "!=", ">", "<", ">=", "<=", "is_null", "is_not_null", "LIKE"
  value?: string | number;
}

export interface FilterValuesOp {
  op: "filter_values";
  conditions: FilterCondition[];
  logic?: "AND" | "OR";
}

export interface DedupOp {
  op: "dedup";
  columns: string[] | null;
}

export interface CalculateOp {
  op: "calculate";
  name: string;
  expression: string;
}

export type CleanOperation = RenameOp | FilterValuesOp | DedupOp | CalculateOp;

// ── Node JSON types ───────────────────────────────────────────────────────────

/** Sub-graph JSON sent to /flows/compile-sql for one node. */
export interface FlowNodeJSON {
  dialect: string;          // "sqlite" | "mysql" | "postgresql"
  connection_id: string;    // which DB connection to use for schema fetching
  nodes: BackendNode[];     // all ancestor nodes + this node
  edges: FlowEdge[];        // all edges within the sub-graph
}

/** Map of nodeId → its FlowNodeJSON (replaces the old nodeSQL string map). */
export type NodeJSONMap = Record<string, FlowNodeJSON>;

// ── Sub-graph collector ───────────────────────────────────────────────────────

/** Walks backwards from nodeId collecting all ancestor node IDs (inclusive). */
function collectAncestors(
  nodeId: string,
  edgesTo: Record<string, string[]>,
): Set<string> {
  const included = new Set<string>();
  const queue = [nodeId];
  while (queue.length) {
    const id = queue.pop()!;
    if (included.has(id)) continue;
    included.add(id);
    for (const parentId of (edgesTo[id] || [])) {
      queue.push(parentId);
    }
  }
  return included;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a NodeJSONMap from the canvas graph.
 * For each node, stores the sub-graph (nodes + edges) leading up to it,
 * plus the source DB dialect and connection_id. Fast — pure graph walking.
 */
export function buildNodeJSONMap(
  nodes: BackendNode[],
  edges: FlowEdge[],
  dialect: string,
  connection_id: string,
): NodeJSONMap {
  if (!nodes.length) return {};

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edgesTo: Record<string, string[]> = {};
  for (const e of edges) {
    (edgesTo[e.to] ??= []).push(e.from);
  }

  const nodeJSON: NodeJSONMap = {};

  for (const node of nodes) {
    if (node.type === "output") continue; // handled separately below

    const ancestorIds = collectAncestors(node.id, edgesTo);
    const subNodes = [...ancestorIds].map((id) => byId[id]).filter(Boolean) as BackendNode[];
    const subEdges = edges.filter((e) => ancestorIds.has(e.from) && ancestorIds.has(e.to));

    nodeJSON[node.id] = { dialect, connection_id, nodes: subNodes, edges: subEdges };
  }

  // Output node → same sub-graph as the node feeding into it
  const outputNode = nodes.find((n) => n.type === "output");
  if (outputNode) {
    const inputId = (outputNode.input as string | undefined) ?? edgesTo[outputNode.id]?.[0];
    nodeJSON[outputNode.id] = inputId && nodeJSON[inputId]
      ? nodeJSON[inputId]
      : { dialect, connection_id, nodes, edges };
  }

  return nodeJSON;
}
