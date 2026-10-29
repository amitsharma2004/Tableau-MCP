/**
 * build-flow-sql.ts
 *
 * Compiles a canvas-built flow graph (nodes + edges) into a SQL SELECT.
 *
 * Step taxonomy (mirrors Tableau Prep's real UX):
 *   source → clean → join → script (passthrough) → union → output
 *
 * Clean step carries all row/column manipulation as ordered sub-operations:
 *   (a) rename         – rename one or more columns
 *   (b) filter_values  – filter rows by conditions
 *   (c) dedup          – identify and remove duplicate rows
 *   (d) calculate      – add a custom calculated column
 *
 * Each sub-op compiles into its own CTE, chained in declaration order.
 * The compiler is deterministic — no LLM call needed for manual canvas edits.
 */

import type { BackendNode } from "./plan-to-graph";

export interface FlowEdge {
  from: string;
  to: string;
}

// ── Clean sub-operation types ─────────────────────────────────────────────────

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
  logic?: "AND" | "OR"; // default: AND
}

export interface DedupOp {
  op: "dedup";
  columns: string[] | null; // null → DISTINCT * (all columns); list → PARTITION BY those cols
}

export interface CalculateOp {
  op: "calculate";
  name: string;       // new column name
  expression: string; // raw SQL expression, e.g. "col_a || '-' || col_b"
}

export type CleanOperation = RenameOp | FilterValuesOp | DedupOp | CalculateOp;

// ── Compile context ───────────────────────────────────────────────────────────

interface CompileContext {
  ctes: Array<[name: string, body: string]>;
  currentCols: string[]; // tracks available columns at each step
  counter: number;
}

function nextName(ctx: CompileContext, prefix: string): string {
  ctx.counter += 1;
  return `${prefix}_${ctx.counter}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FlowSQLResult {
  sql: string;
  nodeSQL: Record<string, string>; // nodeId → executable SQL up to that node
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
  columnMap: Record<string, string[]> = {}, // table/id → known columns from schema
  limit = 1000,
): FlowSQLResult {
  if (!nodes.length) return { sql: "", nodeSQL: {} };

  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  // Build adjacency maps
  const edgesTo: Record<string, string[]> = {};   // node → its parent(s)
  const edgesFrom: Record<string, string[]> = {}; // node → its children
  for (const e of edges) {
    (edgesTo[e.to] ??= []).push(e.from);
    (edgesFrom[e.from] ??= []).push(e.to);
  }

  const sourceNodes = nodes.filter((n) => n.type === "source");
  if (!sourceNodes.length) return { sql: "", nodeSQL: {} };

  // ── Special multi-input shapes ──────────────────────────────────────────────

  const joinNode = nodes.find((n) => n.type === "join");
  if (joinNode) {
    const sql = _buildJoin(joinNode, byId, edgesTo, columnMap, limit);
    const nodeSQL: Record<string, string> = { [joinNode.id]: sql };
    const outputNode = nodes.find((n) => n.type === "output");
    if (outputNode) nodeSQL[outputNode.id] = sql;
    return { sql, nodeSQL };
  }

  const unionNode = nodes.find((n) => n.type === "union");
  if (unionNode) {
    const sql = _buildUnion(unionNode, byId, limit);
    const nodeSQL: Record<string, string> = { [unionNode.id]: sql };
    const outputNode = nodes.find((n) => n.type === "output");
    if (outputNode) nodeSQL[outputNode.id] = sql;
    return { sql, nodeSQL };
  }

  // ── Single linear chain ─────────────────────────────────────────────────────

  // Find terminal node: the node just before output, or the leaf
  const outputNode = nodes.find((n) => n.type === "output");
  let terminalId: string;
  if (outputNode) {
    terminalId = edgesTo[outputNode.id]?.[0] || sourceNodes[0].id;
  } else {
    const leaf = nodes.find((n) => !edgesFrom[n.id]?.length);
    terminalId = leaf?.id || sourceNodes[0].id;
  }

  // Walk backwards terminal → source to get ordered path
  const path: BackendNode[] = [];
  let cur: BackendNode | undefined = byId[terminalId];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    const parentId: string | undefined = edgesTo[cur.id]?.[0];
    cur = parentId ? byId[parentId] : undefined;
  }
  if (!path.length) return { sql: "", nodeSQL: {} };

  // Compile each node in forward order, snapshotting SQL after each node
  const ctx: CompileContext = { ctes: [], currentCols: [], counter: 0 };
  const nodeSQL: Record<string, string> = {};

  for (const node of path) {
    const prev = ctx.ctes.length ? ctx.ctes[ctx.ctes.length - 1][0] : null;

    switch (node.type) {
      case "source":
        _handleSource(node, ctx, columnMap);
        break;

      case "clean":
        _handleClean(node, ctx, prev!);
        break;

      case "script":
        _handleScript(node, ctx, prev!);
        break;

      default:
        if (prev) {
          ctx.ctes.push([node.alias || node.id, `SELECT * FROM ${q(prev)}`]);
        }
        break;
    }

    // Snapshot current chain as this node's executable SQL
    nodeSQL[node.id] = _snapshotSQL(ctx, limit);
  }

  // Also map output node → same SQL as terminal (output has no own transform)
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

  // Each sub-op gets its own CTE, chained in order
  let prev = prevCTE;

  for (const op of operations) {
    switch (op.op) {
      // ── (a) Rename ──────────────────────────────────────────────────────────
      case "rename": {
        const cteName = nextName(ctx, "renamed");
        ctx.ctes.push([
          cteName,
          `SELECT ${_renameSelect(ctx.currentCols, op.mapping)} FROM ${q(prev)}`,
        ]);
        // Update tracked columns after rename
        ctx.currentCols = ctx.currentCols.length
          ? ctx.currentCols.map((c) => op.mapping[c] ?? c)
          : Object.values(op.mapping);
        prev = cteName;
        break;
      }

      // ── (b) Filter Values ───────────────────────────────────────────────────
      case "filter_values": {
        const cteName = nextName(ctx, "filtered");
        ctx.ctes.push([
          cteName,
          `SELECT * FROM ${q(prev)} WHERE ${_buildWhere(op)}`,
        ]);
        prev = cteName;
        break;
      }

      // ── (c) Identify Duplicate Rows ─────────────────────────────────────────
      case "dedup": {
        const cteName = nextName(ctx, "deduped");
        if (op.columns && op.columns.length) {
          // Partition by specific columns
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
        } else {
          // Partition by all columns → exact duplicate removal
          if (ctx.currentCols.length) {
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
            // Schema unknown: fall back to DISTINCT
            ctx.ctes.push([cteName, `SELECT DISTINCT * FROM ${q(prev)}`]);
          }
        }
        prev = cteName;
        break;
      }

      // ── (d) Create Custom Calculated Field ──────────────────────────────────
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
  // Script steps (Python/R) run at execution time — SQL just passes rows through.
  // Mark clearly so downstream tooling knows to intercept.
  const cteName = nextName(ctx, "script_passthrough");
  ctx.ctes.push([cteName, `SELECT * FROM ${q(prevCTE)} /* script step: ${node.id} */`]);
}

// ── Multi-input shapes ────────────────────────────────────────────────────────

function _buildJoin(
  joinNode: BackendNode,
  byId: Record<string, BackendNode>,
  edgesTo: Record<string, string[]>,
  columnMap: Record<string, string[]>,
  limit: number,
): string {
  const leftInputId = joinNode.left_input || "";
  const rightInputId = joinNode.right_input || "";
  if (!byId[leftInputId] || !byId[rightInputId]) return "";

  const jt = (((joinNode as Record<string, unknown>).join_type as string) || "INNER").toUpperCase();

  // Walk a branch from terminalId back to its source, compiling CTEs into ctx.
  // Returns the name of the last CTE (the alias to JOIN on).
  function compileBranch(terminalId: string, ctx: CompileContext): string {
    const path: BackendNode[] = [];
    let cur: BackendNode | undefined = byId[terminalId];
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      // Follow first parent that is not the join node itself
      const parentId = (edgesTo[cur.id] || []).find(
        (pid) => byId[pid] && byId[pid].type !== "join"
      );
      cur = parentId ? byId[parentId] : undefined;
    }
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
        default:
          if (prev) ctx.ctes.push([node.alias || node.id, `SELECT * FROM ${q(prev)}`]);
          break;
      }
    }
    return ctx.ctes.length ? ctx.ctes[ctx.ctes.length - 1][0] : terminalId;
  }

  // Shared context so counter increments across both branches → no CTE name collisions
  const ctx: CompileContext = { ctes: [], currentCols: [], counter: 0 };
  const leftAlias = compileBranch(leftInputId, ctx);
  const rightAlias = compileBranch(rightInputId, ctx);

  // Build ON clause from the stored condition string "leftNodeId.col = rightNodeId.col"
  // Extract just the column names and rewrite using the compiled CTE aliases.
  const condition = (joinNode as Record<string, unknown>).condition as string | undefined;
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

  const joinSQL = `SELECT *\nFROM ${q(leftAlias)}\n${jt} JOIN ${q(rightAlias)}\n  ON ${onClause}\nLIMIT ${limit}`;

  if (!ctx.ctes.length) return joinSQL;
  const withClause = ctx.ctes.map(([name, body]) => `${q(name)} AS (\n  ${body}\n)`).join(",\n");
  return `WITH ${withClause}\n${joinSQL}`;
}

function _buildUnion(
  unionNode: BackendNode,
  byId: Record<string, BackendNode>,
  limit: number,
): string {
  const inputs = (unionNode.inputs || []) as string[];
  const parts = inputs
    .map((id) => {
      const n = byId[id];
      return n ? `SELECT * FROM ${q(n.table || id)}` : null;
    })
    .filter(Boolean) as string[];

  return parts.length ? `${parts.join("\nUNION ALL\n")}\nLIMIT ${limit}` : "";
}

// ── Clause builders ───────────────────────────────────────────────────────────

/**
 * Builds SELECT clause for a rename op.
 * If schema is known → explicit col list with aliases.
 * If not → SELECT *, old AS new (avoids losing unknown cols).
 */
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

/**
 * Builds WHERE clause from a filter_values op's structured conditions.
 */
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

/** Wraps identifier in double quotes for safe SQL usage. */
function q(name: string): string {
  return `"${name}"`;
}