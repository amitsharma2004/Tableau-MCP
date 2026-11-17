/**
 * build-flow-sql.ts
 *
 * Compiles a canvas-built flow graph (nodes + edges) into a SQL SELECT.
 *
 * All node types are handled in a single unified loop. Join and union nodes
 * compile their own input branches internally and push a named CTE into the
 * shared context — downstream nodes (rename, filter, etc.) then receive that
 * CTE as their `prev` input just like any other node.
 *
 * Clean step carries all row/column manipulation as ordered sub-operations:
 *   (a) rename         – rename one or more columns
 *   (b) filter_values  – filter rows by conditions
 *   (c) dedup          – identify and remove duplicate rows
 *   (d) calculate      – add a custom calculated column
 */

import type { BackendNode } from "./plan-to-graph";

export interface FlowEdge {
  from: string;
  to: string;
}

// ── Clean sub-operation types ─────────────────────────────────────────────────

export interface RenameOp {
  op: "rename";
  mapping: Record<string, string>;
}

export interface FilterCondition {
  column: string;
  operator: string;
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

// ── Compile context ───────────────────────────────────────────────────────────

interface CompileContext {
  ctes: Array<[name: string, body: string]>;
  currentCols: string[];
  counter: number;
}

function nextName(ctx: CompileContext, prefix: string): string {
  ctx.counter += 1;
  return `${prefix}_${ctx.counter}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FlowSQLResult {
  sql: string;
  nodeSQL: Record<string, string>;
}

/** Snapshot the current CTE chain as a standalone executable SQL. */
function _snapshotSQL(ctx: CompileContext, limit: number): string {
  if (!ctx.ctes.length) return "";
  if (ctx.ctes.length === 1) return `${ctx.ctes[0][1]}\nLIMIT ${limit}`;
  const withClause = ctx.ctes
    .map(([name, body]) => `${q(name)} AS (\n  ${body}\n)`)
    .join(",\n");
  const last = ctx.ctes[ctx.ctes.length - 1][0];
  return `WITH ${withClause}\nSELECT * FROM ${q(last)}\nLIMIT ${limit}`;
}

export function buildFlowSQL(
  nodes: BackendNode[],
  edges: FlowEdge[],
  columnMap: Record<string, string[]> = {},
  limit = 1000,
): FlowSQLResult {
  if (!nodes.length) return { sql: "", nodeSQL: {} };

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const edgesTo: Record<string, string[]> = {};
  const edgesFrom: Record<string, string[]> = {};
  for (const e of edges) {
    (edgesTo[e.to] ??= []).push(e.from);
    (edgesFrom[e.from] ??= []).push(e.to);
  }

  const sourceNodes = nodes.filter((n) => n.type === "source");
  if (!sourceNodes.length) return { sql: "", nodeSQL: {} };

  // Find terminal node: node just before output, or the leaf
  const outputNode = nodes.find((n) => n.type === "output");
  let terminalId: string;
  if (outputNode) {
    terminalId = edgesTo[outputNode.id]?.[0] || sourceNodes[0].id;
  } else {
    const leaf = nodes.find((n) => !edgesFrom[n.id]?.length);
    terminalId = leaf?.id || sourceNodes[0].id;
  }

  // Walk backwards terminal → source, stopping at join/union nodes.
  // Join/union handle their own input branches internally — the path only
  // covers the downstream (post-join) portion of the chain.
  const path: BackendNode[] = [];
  let cur: BackendNode | undefined = byId[terminalId];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    if (cur.type === "join" || cur.type === "union") break;
    const parentId: string | undefined = edgesTo[cur.id]?.[0];
    cur = parentId ? byId[parentId] : undefined;
  }
  if (!path.length) return { sql: "", nodeSQL: {} };

  const ctx: CompileContext = { ctes: [], currentCols: [], counter: 0 };
  const nodeSQL: Record<string, string> = {};

  for (const node of path) {
    const prev = ctx.ctes.length ? ctx.ctes[ctx.ctes.length - 1][0] : null;

    switch (node.type) {
      case "source":
        _handleSource(node, ctx, columnMap);
        break;

      case "clean":
        if (prev) _handleClean(node, ctx, prev);
        break;

      case "script":
        if (prev) _handleScript(node, ctx, prev);
        break;

      case "join":
        _handleJoin(node, ctx, edgesTo, byId, columnMap, nodeSQL, limit);
        break;

      case "union":
        _handleUnion(node, ctx, byId, columnMap);
        break;

      case "rename": {
        if (prev) {
          const mapping = (node.mappings ?? (node as Record<string, unknown>).mapping ?? {}) as Record<string, string>;
          const cteName = nextName(ctx, "renamed");
          ctx.ctes.push([cteName, `SELECT ${_renameSelect(ctx.currentCols, mapping)} FROM ${q(prev)}`]);
          ctx.currentCols = ctx.currentCols.length
            ? ctx.currentCols.map((c) => mapping[c] ?? c)
            : Object.values(mapping);
        }
        break;
      }
      
      case "filter": {
        if (prev) {
          const details = (node as Record<string, unknown>).details as Record<string, unknown> | undefined;
          const conditions = (details?.conditions ?? (node as Record<string, unknown>).conditions ?? []) as Array<{ column: string; operator: string; value?: unknown }>;
          const logic = ((details?.logic ?? (node as Record<string, unknown>).logic) as string | undefined)?.toUpperCase() || "AND";
          if (conditions.length) {
            const where = conditions
              .map((c) => {
                const col = q(c.column);
                if (c.operator === "is_null") return `${col} IS NULL`;
                if (c.operator === "is_not_null") return `${col} IS NOT NULL`;
                const val = typeof c.value === "number" ? c.value : `'${String(c.value ?? "").replace(/'/g, "''")}'`;
                return `${col} ${c.operator} ${val}`;
              })
              .join(` ${logic} `);
            const cteName = nextName(ctx, "filtered");
            ctx.ctes.push([cteName, `SELECT * FROM ${q(prev)} WHERE ${where}`]);
          } else {
            ctx.ctes.push([nextName(ctx, "filtered"), `SELECT * FROM ${q(prev)}`]);
          }
        }
        break;
      }

      case "aggregate": {
        if (prev) {
          const details = (node as Record<string, unknown>).details as Record<string, unknown> | undefined;
          const groupBy = (details?.group_by ?? (node as Record<string, unknown>).group_by ?? []) as string[];
          const aggregations = (details?.aggregations ?? (node as Record<string, unknown>).aggregations ?? []) as Array<{ column: string; function?: string; func?: string; alias: string }>;
          const groupCols = groupBy.map(q).join(", ");
          const aggCols = aggregations.map((a) => `${(a.function || a.func || "COUNT").toUpperCase()}(${q(a.column)}) AS ${q(a.alias)}`).join(", ");
          const selectCols = [groupCols, aggCols].filter(Boolean).join(", ") || "*";
          const cteName = nextName(ctx, "aggregated");
          ctx.ctes.push([cteName, `SELECT ${selectCols} FROM ${q(prev)}${groupBy.length ? ` GROUP BY ${groupCols}` : ""}`]);
          ctx.currentCols = [...groupBy, ...aggregations.map((a) => a.alias)];
        }
        break;
      }

      case "calculate": {
        if (prev) {
          const details = (node as Record<string, unknown>).details as Record<string, unknown> | undefined;
          const calculations = (details?.calculations ?? (node as Record<string, unknown>).calculations ?? []) as Array<{ name: string; expression: string }>;
          const existingCols = ctx.currentCols.length ? ctx.currentCols.map(q).join(", ") + ", " : "*, ";
          const calcCols = calculations.map((c) => `${c.expression} AS ${q(c.name)}`).join(", ");
          const cteName = nextName(ctx, "calculated");
          ctx.ctes.push([cteName, `SELECT ${existingCols}${calcCols || "*"} FROM ${q(prev)}`]);
          ctx.currentCols = [...ctx.currentCols, ...calculations.map((c) => c.name)];
        }
        break;
      }

      case "sort": {
        if (prev) {
          const details = (node as Record<string, unknown>).details as Record<string, unknown> | undefined;
          const sortBy = (details?.sort_by ?? (node as Record<string, unknown>).sort_by ?? []) as Array<{ column: string; direction?: string }>;
          const cteName = nextName(ctx, "sorted");
          if (sortBy.length) {
            const orderCols = sortBy.map((s) => `${q(s.column)} ${(s.direction || "ASC").toUpperCase()}`).join(", ");
            ctx.ctes.push([cteName, `SELECT * FROM ${q(prev)} ORDER BY ${orderCols}`]);
          } else {
            ctx.ctes.push([cteName, `SELECT * FROM ${q(prev)}`]);
          }
        }
        break;
      }

      default:
        if (prev) {
          ctx.ctes.push([node.alias || node.id, `SELECT * FROM ${q(prev)}`]);
        }
        break;
    }

    nodeSQL[node.id] = _snapshotSQL(ctx, limit);
  }

  if (outputNode) nodeSQL[outputNode.id] = nodeSQL[terminalId] ?? "";

  if (!ctx.ctes.length) return { sql: "", nodeSQL };
  const sql = _snapshotSQL(ctx, limit);
  return { sql, nodeSQL };
}

// ── Node handlers ─────────────────────────────────────────────────────────────

function _handleSource(
  node: BackendNode,
  ctx: CompileContext,
  columnMap: Record<string, string[]>,
): void {
  const table = node.table || node.id;
  const cteName = `src_${table}`;
  ctx.currentCols = columnMap[table] || columnMap[node.id] || [];
  ctx.ctes.push([cteName, `SELECT * FROM ${q(table)}`]);
}

function _handleClean(
  node: BackendNode,
  ctx: CompileContext,
  prevCTE: string,
): void {
  const operations =
    ((node as Record<string, unknown>).operations as CleanOperation[] | undefined) || [];

  let prev = prevCTE;

  for (const op of operations) {
    switch (op.op) {
      case "rename": {
        const cteName = nextName(ctx, "renamed");
        ctx.ctes.push([
          cteName,
          `SELECT ${_renameSelect(ctx.currentCols, op.mapping)} FROM ${q(prev)}`,
        ]);
        ctx.currentCols = ctx.currentCols.length
          ? ctx.currentCols.map((c) => op.mapping[c] ?? c)
          : Object.values(op.mapping);
        prev = cteName;
        break;
      }

      case "filter_values": {
        const cteName = nextName(ctx, "filtered");
        ctx.ctes.push([
          cteName,
          `SELECT * FROM ${q(prev)} WHERE ${_buildWhere(op)}`,
        ]);
        prev = cteName;
        break;
      }

      case "dedup": {
        const cteName = nextName(ctx, "deduped");
        if (op.columns && op.columns.length) {
          const partition = op.columns.map(q).join(", ");
          ctx.ctes.push([
            cteName,
            `SELECT * FROM (\n` +
            `    SELECT *, ROW_NUMBER() OVER (\n` +
            `      PARTITION BY ${partition}\n` +
            `      ORDER BY rowid\n` +
            `    ) AS _rn\n` +
            `    FROM ${q(prev)}\n` +
            `  ) WHERE _rn = 1`,
          ]);
        } else if (ctx.currentCols.length) {
          const partition = ctx.currentCols.map(q).join(", ");
          ctx.ctes.push([
            cteName,
            `SELECT * FROM (\n` +
            `    SELECT *, ROW_NUMBER() OVER (\n` +
            `      PARTITION BY ${partition}\n` +
            `      ORDER BY rowid\n` +
            `    ) AS _rn\n` +
            `    FROM ${q(prev)}\n` +
            `  ) WHERE _rn = 1`,
          ]);
        } else {
          ctx.ctes.push([cteName, `SELECT DISTINCT * FROM ${q(prev)}`]);
        }
        prev = cteName;
        break;
      }

      case "calculate": {
        const cteName = nextName(ctx, "calculated");
        const existingCols = ctx.currentCols.length
          ? ctx.currentCols.map(q).join(", ") + ",\n    "
          : "*, ";
        ctx.ctes.push([
          cteName,
          `SELECT\n    ${existingCols}${op.expression} AS ${q(op.name)}\n  FROM ${q(prev)}`,
        ]);
        ctx.currentCols = [...ctx.currentCols, op.name];
        prev = cteName;
        break;
      }
    }
  }
}

function _handleScript(
  node: BackendNode,
  ctx: CompileContext,
  prevCTE: string,
): void {
  const cteName = nextName(ctx, "script_passthrough");
  ctx.ctes.push([cteName, `SELECT * FROM ${q(prevCTE)} /* script step: ${node.id} */`]);
}

// ── Join handler — compiles both branches into ctx then pushes joined CTE ─────

function _handleJoin(
  node: BackendNode,
  ctx: CompileContext,
  edgesTo: Record<string, string[]>,
  byId: Record<string, BackendNode>,
  columnMap: Record<string, string[]>,
  nodeSQL: Record<string, string>,
  limit: number,
): void {
  const leftInputId = (node.left_input as string) || "";
  const rightInputId = (node.right_input as string) || "";
  if (!byId[leftInputId] || !byId[rightInputId]) return;

  // Compile a single input branch into the shared ctx, return last CTE name.
  function compileBranch(terminalId: string): string {
    const branchPath: BackendNode[] = [];
    let cur: BackendNode | undefined = byId[terminalId];
    const visited = new Set<string>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      branchPath.unshift(cur);
      // Don't cross join node boundaries
      const parentId = (edgesTo[cur.id] || []).find(
        (pid) => byId[pid] && byId[pid].type !== "join"
      );
      cur = parentId ? byId[parentId] : undefined;
    }
    for (const n of branchPath) {
      const prev = ctx.ctes.length ? ctx.ctes[ctx.ctes.length - 1][0] : null;
      switch (n.type) {
        case "source": _handleSource(n, ctx, columnMap); break;
        case "clean": if (prev) _handleClean(n, ctx, prev); break;
        case "script": if (prev) _handleScript(n, ctx, prev); break;
        case "rename": {
          if (prev) {
            const mapping = (n.mappings ?? (n as Record<string, unknown>).mapping ?? {}) as Record<string, string>;
            const cteName = nextName(ctx, "renamed");
            ctx.ctes.push([cteName, `SELECT ${_renameSelect(ctx.currentCols, mapping)} FROM ${q(prev)}`]);
            ctx.currentCols = ctx.currentCols.length ? ctx.currentCols.map((c) => mapping[c] ?? c) : Object.values(mapping);
          }
          break;
        }
        default: if (prev) ctx.ctes.push([n.alias || n.id, `SELECT * FROM ${q(prev)}`]); break;
      }
      nodeSQL[n.id] = _snapshotSQL(ctx, limit);
    }
    return ctx.ctes.length ? ctx.ctes[ctx.ctes.length - 1][0] : terminalId;
  }

  const leftAlias = compileBranch(leftInputId);
  const rightAlias = compileBranch(rightInputId);

  const jt = ((node as Record<string, unknown>).join_type as string || "INNER").toUpperCase();
  const condition = (node as Record<string, unknown>).condition as string | undefined;
  let onClause = "1=1";
  if (condition) {
    const eqIdx = condition.indexOf(" = ");
    if (eqIdx >= 0) {
      const leftPart = condition.slice(0, eqIdx).trim();
      const rightPart = condition.slice(eqIdx + 3).trim();
      const leftCol = leftPart.includes(".") ? leftPart.slice(leftPart.lastIndexOf(".") + 1) : leftPart;
      const rightCol = rightPart.includes(".") ? rightPart.slice(rightPart.lastIndexOf(".") + 1) : rightPart;
      onClause = `${q(leftAlias)}.${q(leftCol)} = ${q(rightAlias)}.${q(rightCol)}`;
    }
  }

  const joinCteName = nextName(ctx, "joined");
  ctx.ctes.push([joinCteName, `SELECT *\nFROM ${q(leftAlias)}\n${jt} JOIN ${q(rightAlias)}\n  ON ${onClause}`]);
  ctx.currentCols = [];
}

// ── Union handler — pushes UNION ALL CTE into ctx ─────────────────────────────

function _handleUnion(
  node: BackendNode,
  ctx: CompileContext,
  byId: Record<string, BackendNode>,
  columnMap: Record<string, string[]>,
): void {
  const inputs = (node.inputs || []) as string[];
  const parts = inputs
    .map((id) => {
      const n = byId[id];
      if (!n) return null;
      const table = n.type === "source" ? (n.table || n.id) : (n.alias || n.id);
      return `SELECT * FROM ${q(table)}`;
    })
    .filter(Boolean) as string[];

  if (!parts.length) return;
  const unionCteName = nextName(ctx, "unioned");
  ctx.ctes.push([unionCteName, parts.join("\nUNION ALL\n")]);
  ctx.currentCols = [];
}

// ── Clause builders ───────────────────────────────────────────────────────────

function _renameSelect(
  allCols: string[],
  mapping: Record<string, string>,
): string {
  if (!allCols.length) {
    const aliases = Object.entries(mapping)
      .map(([old, newName]) => `${q(old)} AS ${q(newName)}`)
      .join(", ");
    return aliases ? `*, ${aliases}` : "*";
  }
  return allCols
    .map((c) => (mapping[c] ? `${q(c)} AS ${q(mapping[c])}` : q(c)))
    .join(", ");
}

function _buildWhere(op: FilterValuesOp): string {
  const { conditions, logic = "AND" } = op;
  if (!conditions.length) return "1=1";

  const parts = conditions.map((c) => {
    const col = q(c.column);
    if (c.operator === "is_null") return `${col} IS NULL`;
    if (c.operator === "is_not_null") return `${col} IS NOT NULL`;
    const val =
      typeof c.value === "number"
        ? c.value
        : `'${String(c.value ?? "").replace(/'/g, "''")}'`;
    return `${col} ${c.operator} ${val}`;
  });

  return parts.join(` ${logic.toUpperCase()} `);
}

function q(name: string): string {
  return `"${name}"`;
}
