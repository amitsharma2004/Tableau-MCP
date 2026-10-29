"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { useActor } from "@/lib/actor-context";
import { buildFlowSQL, type FlowSQLResult } from "@/lib/flow-sql";
import type { Connection } from "@/lib/types";
import { VisualFlowCanvas } from "@/components/visual-flow-canvas";
import TableauDataProfiler from "@/components/tableau-data-profiler";
import { TableauStepChanges } from "@/components/tableau-step-changes";
import { DataTable } from "@/components/data-table";
import { JoinConfigModal } from "@/components/join-config-modal";
import { JoinColumnPicker } from "@/components/join-column-picker";
import { StepActionModal } from "@/components/step-action-modal";
import type { PrepNodeData } from "@/lib/plan-to-graph";
import type { BackendNode, BackendFlow } from "@/lib/plan-to-graph";
import {
  Sparkles,
  Play,
  CloudUpload,
  CheckCircle2,
  AlertCircle,
  Database,
  RefreshCw,
  ChevronLeft,
  Eye,
  Table,
  X,
  Search,
  Plus,
  Download,
  Upload,
  Save,
  History,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface BackendEdge {
  from: string;
  to: string;
}

interface Checkpoint {
  id: string;
  flow_id: string;
  version_number: number;
  nodes: BackendNode[];
  edges: BackendEdge[];
  sql: string;
  change_summary: string | null;
  created_at: string;
  created_by: string;
}

// ── Page ─────────────────────────────────────────────────────────────────────

function FlowStudioContent() {
  const searchParams = useSearchParams();
  const flowIdParam = searchParams.get("flowId");
  const { actorEmail } = useActor();

  // Connection / table sidebar
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [databaseTables, setDatabaseTables] = useState<any[]>([]);
  const [tableSearch, setTableSearch] = useState<string>("");
  const [isLoadingTables, setIsLoadingTables] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Current flow (persisted record from backend)
  const [currentFlow, setCurrentFlow] = useState<Record<string, any> | null>(null);
  const [isFlowLoading, setIsFlowLoading] = useState<boolean>(false);

  // Canvas state — native nodes/edges/sql format
  const [nodes, setNodes] = useState<BackendNode[]>([]);
  const [edges, setEdges] = useState<BackendEdge[]>([]);
  const [sql, setSql] = useState<string>("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);

  // Checkpoints (version history)
  const [isSavingCheckpoint, setIsSavingCheckpoint] = useState<boolean>(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState<boolean>(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);

  // Run / publish
  const [isRunning, setIsRunning] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishSuccess, setPublishSuccess] = useState<string | null>(null);

  // Node preview drawer
  const [selectedNode, setSelectedNode] = useState<PrepNodeData | null>(null);
  const [nodeDataRows, setNodeDataRows] = useState<Record<string, unknown>[] | null>(null);
  const [isLoadingNodeData, setIsLoadingNodeData] = useState(false);
  const previewDrawerRef = useRef<HTMLDivElement>(null);

  // Per-node SQL map: nodeId → executable SQL up to that node (manual/edited flows)
  const [nodeSQL, setNodeSQL] = useState<Record<string, string>>({});

  // File upload
  const [isUploadingFile, setIsUploadingFile] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // True only after the user makes a canvas edit — keeps MCP SQL intact on load
  const canvasEdited = useRef(false);

  // Modals
  const [joinModalConfig, setJoinModalConfig] = useState<{
    isOpen: boolean; leftTable: string; rightTable: string;
    leftColumns: string[]; rightColumns: string[];
    pendingJoinNodeId?: string; // set when completing a placeholder join node
  }>({ isOpen: false, leftTable: "", rightTable: "", leftColumns: [], rightColumns: [] });

  const [columnPickerConfig, setColumnPickerConfig] = useState<{
    isOpen: boolean; leftTable: string; rightTable: string;
    leftColumns: string[]; rightColumns: string[];
    pendingJoinNodeId: string;
  }>({ isOpen: false, leftTable: "", rightTable: "", leftColumns: [], rightColumns: [], pendingJoinNodeId: "" });

  const [stepActionModal, setStepActionModal] = useState<{
    isOpen: boolean; sourceAlias: string; targetAlias: string; columns: string[];
  }>({ isOpen: false, sourceAlias: "", targetAlias: "", columns: [] });

  // ── Load connections ──────────────────────────────────────────────────────

  async function refreshConnections() {
    const conns = await api.listConnections(actorEmail);
    setConnections(conns);
    return conns;
  }

  useEffect(() => {
    refreshConnections().then((conns) => {
      const src = conns.find((c) => c.type === "sqlite" || c.type === "postgres" || c.type === "mysql");
      if (src && !selectedConnectionId) setSelectedConnectionId(src.id);
    });
  }, [actorEmail]);

  // ── Load flow if flowId in URL ────────────────────────────────────────────

  useEffect(() => {
    if (!flowIdParam) return;
    setIsFlowLoading(true);
    api.getBackendFlow(actorEmail, flowIdParam)
      .then((flow) => {
        setCurrentFlow(flow);
        if (flow.connection_id) setSelectedConnectionId(flow.connection_id as string);
        setNodes((flow.nodes as BackendNode[]) || []);
        setEdges((flow.edges as BackendEdge[]) || []);
        setSql((flow.sql as string) || "");
        setHasUnsavedChanges(false);
      })
      .catch((err) => setError(`Failed to load flow: ${err instanceof ApiError ? err.message : String(err)}`))
      .finally(() => setIsFlowLoading(false));
  }, [actorEmail, flowIdParam]);

  // ── Load tables when connection changes ───────────────────────────────────

  useEffect(() => {
    if (!selectedConnectionId) { setDatabaseTables([]); return; }
    setIsLoadingTables(true);
    api.getConnectionSchema(actorEmail, selectedConnectionId)
      .then((res) => setDatabaseTables(res.tables || []))
      .catch((err) => console.error("Failed to load schema:", err))
      .finally(() => setIsLoadingTables(false));
  }, [actorEmail, selectedConnectionId]);

  // ── File upload ───────────────────────────────────────────────────────────

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingFile(true);
    setError(null);
    try {
      const newConn = await api.uploadFile(actorEmail, file);
      await refreshConnections();
      setSelectedConnectionId(newConn.id);
      const schema = await api.getConnectionSchema(actorEmail, newConn.id);
      setDatabaseTables(schema.tables || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to upload file");
    } finally {
      setIsUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getColumnsForAlias(alias: string, visited = new Set<string>()): string[] {
    if (visited.has(alias)) return [];
    visited.add(alias);

    // Match source nodes by id OR alias OR table name (canvas passes n.id as alias)
    for (const n of nodes) {
      if (n.type === "source") {
        const match =
          n.id.toLowerCase() === alias.toLowerCase() ||
          (n.alias ?? "").toLowerCase() === alias.toLowerCase() ||
          (n.table ?? "").toLowerCase() === alias.toLowerCase();
        if (match && n.table) {
          const dbTable = databaseTables.find(
            (t) => t.name.toLowerCase() === (n.table as string).toLowerCase()
          );
          if (dbTable?.columns?.length) return dbTable.columns.map((c: any) => c.name as string);
        }
      }
    }

    // Direct table name match in schema
    const byName = databaseTables.find((t) => t.name.toLowerCase() === alias.toLowerCase());
    if (byName?.columns?.length) return byName.columns.map((c: any) => c.name as string);

    // Trace upstream through edges for transform / clean / join nodes
    const parentEdge = edges.find((e) => e.to === alias);
    if (parentEdge) return getColumnsForAlias(parentEdge.from, visited);

    return [];
  }

  // Build { tableName: columnNames[] } from databaseTables for buildFlowSQL
  function buildColumnMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const t of databaseTables) {
      if (t.name && t.columns?.length) {
        map[t.name] = t.columns.map((c: any) => c.name as string);
      }
    }
    return map;
  }

  function exportToCsv(rows: Record<string, unknown>[] | null, filename = "export.csv") {
    if (!rows?.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map((row) =>
        headers.map((h) => {
          const v = row[h];
          if (v === null || v === undefined) return "";
          return `"${String(v).replace(/"/g, '""')}"`;
        }).join(",")
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Ensure flow exists, create if needed ──────────────────────────────────

  async function ensureFlow(tableName?: string): Promise<Record<string, any>> {
    if (currentFlow) return currentFlow;
    const flow = await api.createBackendFlow(actorEmail, {
      name: tableName ? `Flow with ${tableName}` : "New Flow",
      connection_id: selectedConnectionId,
    });
    setCurrentFlow(flow);
    window.history.replaceState(null, "", `/flows/new?flowId=${flow.flow_id}`);
    return flow;
  }

  // ── Canvas: add table by drag or click ───────────────────────────────────

  async function handleAddTableToCanvas(tableName: string, schemaName: string = "main") {
    if (!selectedConnectionId) {
      setError("Please select a data source connection first.");
      return;
    }
    try {
      await ensureFlow(tableName);
      const nodeId = `source_${tableName.toLowerCase().replace(/\W/g, "_")}`;
      if (nodes.find((n) => n.id === nodeId)) {
        handleNodeSelect({ label: tableName, type: "source", alias: tableName.toLowerCase(), description: `${schemaName}.${tableName}` } as PrepNodeData);
        return;
      }
      const newNode: BackendNode = { id: nodeId, type: "source", table: tableName, name: tableName, alias: tableName.toLowerCase() };
      setNodes((prev) => [...prev, newNode]);
      canvasEdited.current = true;
      setHasUnsavedChanges(true);
      handleNodeSelect({ label: tableName, type: "source", alias: tableName.toLowerCase(), description: `${schemaName}.${tableName}`, details: { schema: schemaName, table: tableName } } as PrepNodeData);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add table");
    }
  }

  // ── Join modal ────────────────────────────────────────────────────────────

  function handleConnectNodes(sourceAlias: string, targetAlias: string) {
    const sourceNode = nodes.find((n) => n.id === sourceAlias);
    const targetNode = nodes.find((n) => n.id === targetAlias);

    // Pending join placeholder as SOURCE — user drew edge from join node to a table
    if (sourceNode?.type === "join" && sourceNode.left_input && !sourceNode.right_input) {
      const leftInput = sourceNode.left_input as string;
      setColumnPickerConfig({
        isOpen: true,
        leftTable: leftInput,
        rightTable: targetAlias,
        leftColumns: getColumnsForAlias(leftInput),
        rightColumns: getColumnsForAlias(targetAlias),
        pendingJoinNodeId: sourceAlias,
      });
      return;
    }

    // Pending join placeholder as TARGET — user drew edge from a table to the join node
    if (targetNode?.type === "join" && targetNode.left_input && !targetNode.right_input) {
      const leftInput = targetNode.left_input as string;
      setColumnPickerConfig({
        isOpen: true,
        leftTable: leftInput,
        rightTable: sourceAlias,
        leftColumns: getColumnsForAlias(leftInput),
        rightColumns: getColumnsForAlias(sourceAlias),
        pendingJoinNodeId: targetAlias,
      });
      return;
    }

    // Two arbitrary non-join nodes connected: insert a join placeholder (left side only),
    // then open JoinColumnPicker. Picker's confirm adds right_input + the right edge.
    const nodeId = `join_${Date.now()}`;
    const newNode: BackendNode = {
      id: nodeId, type: "join", name: nodeId,
      left_input: sourceAlias, right_input: "",
      join_type: "inner",
    };
    setNodes((prev) => [...prev, newNode]);
    setEdges((prev) => [
      ...prev.filter((e) => !(e.from === sourceAlias && e.to === targetAlias)),
      { from: sourceAlias, to: nodeId },
    ]);
    canvasEdited.current = true;
    setHasUnsavedChanges(true);
    setColumnPickerConfig({
      isOpen: true,
      leftTable: sourceAlias,
      rightTable: targetAlias,
      leftColumns: getColumnsForAlias(sourceAlias),
      rightColumns: getColumnsForAlias(targetAlias),
      pendingJoinNodeId: nodeId,
    });
  }

  function handleApplyJoin(config: { joinType: "inner"|"left"|"right"|"full"; leftCol: string; rightCol: string; outputAlias: string }) {
    const condStr = `${joinModalConfig.leftTable}.${config.leftCol} = ${joinModalConfig.rightTable}.${config.rightCol}`;

    if (joinModalConfig.pendingJoinNodeId) {
      // Update an existing join node (user clicked it to reconfigure)
      const existingId = joinModalConfig.pendingJoinNodeId;
      setNodes((prev) =>
        prev.map((n) =>
          n.id === existingId
            ? { ...n, join_type: config.joinType, condition: condStr }
            : n
        )
      );
      canvasEdited.current = true;
      setHasUnsavedChanges(true);
      return;
    }

    // Create a brand-new join node (connecting two arbitrary nodes)
    const nodeId = config.outputAlias;
    const newNode: BackendNode = {
      id: nodeId, type: "join", name: nodeId,
      left_input: joinModalConfig.leftTable, right_input: joinModalConfig.rightTable,
      join_type: config.joinType,
      condition: condStr,
    };
    setNodes((prev) => [...prev, newNode]);
    setEdges((prev) => [
      ...prev,
      { from: joinModalConfig.leftTable, to: nodeId },
      { from: joinModalConfig.rightTable, to: nodeId },
    ]);
    canvasEdited.current = true;
    setHasUnsavedChanges(true);
    handleNodeSelect({ label: nodeId, type: "join", alias: nodeId, description: `${config.joinType.toUpperCase()} join` } as PrepNodeData);
  }

  function handleApplyUnion(config: { inputs: string[]; distinct: boolean; outputAlias: string }) {
    const nodeId = config.outputAlias;
    const newNode: BackendNode = { id: nodeId, type: "union", name: nodeId, inputs: config.inputs };
    setNodes((prev) => [...prev, newNode]);
    setEdges((prev) => [...prev, ...config.inputs.map((inp) => ({ from: inp, to: nodeId }))]);
    canvasEdited.current = true;
    setHasUnsavedChanges(true);
    handleNodeSelect({ label: nodeId, type: "union", alias: nodeId } as PrepNodeData);
  }

  // ── Step action modal ─────────────────────────────────────────────────────

  function handleAddStepOnEdge(sourceAlias: string, targetAlias: string) {
    setStepActionModal({ isOpen: true, sourceAlias, targetAlias, columns: getColumnsForAlias(sourceAlias) });
  }

  function handleAddStepFromNode(sourceAlias: string, stepType?: string) {
    if (stepType === "join") {
      // Add a placeholder join node — user drags the second table to it to complete the join
      const nodeId = `join_${Date.now()}`;
      const newNode: BackendNode = {
        id: nodeId, type: "join", name: nodeId,
        left_input: sourceAlias, right_input: "",
        join_type: "inner",
      };
      setNodes((prev) => [...prev, newNode]);
      setEdges((prev) => [...prev, { from: sourceAlias, to: nodeId }]);
      canvasEdited.current = true;
      setHasUnsavedChanges(true);
      return;
    }
    setStepActionModal({ isOpen: true, sourceAlias, targetAlias: "", columns: getColumnsForAlias(sourceAlias) });
  }

  function handleApplyCustomStep(newStep: any) {
    const nodeId = newStep.output_alias;
    const sourceAlias = stepActionModal.sourceAlias;
    const newNode: BackendNode = { id: nodeId, type: newStep.type, name: nodeId, input: sourceAlias, ...newStep };
    setNodes((prev) => [...prev, newNode]);
    setEdges((prev) => {
      // Rewire existing edge from sourceAlias → targetAlias to pass through new step
      const targetAlias = stepActionModal.targetAlias;
      const rewired = prev.map((e) =>
        e.from === sourceAlias && e.to === targetAlias ? { ...e, from: nodeId } : e
      );
      return [...rewired, { from: sourceAlias, to: nodeId }];
    });
    canvasEdited.current = true;
    setHasUnsavedChanges(true);
    handleNodeSelect({ label: nodeId, type: newStep.type, alias: nodeId } as PrepNodeData);
  }

  function handleDeleteStep(aliasToDelete: string) {
    const node = nodes.find((n) => n.id === aliasToDelete);
    const isSource = node?.type === "source";

    if (isSource) {
      // Remove source node and all edges connected to it (no rewiring)
      setEdges((prev) => prev.filter((e) => e.from !== aliasToDelete && e.to !== aliasToDelete));
    } else {
      // For transform nodes: rewire children to parent
      const parentEdge = edges.find((e) => e.to === aliasToDelete);
      const parentAlias = parentEdge?.from || "";
      setEdges((prev) =>
        prev
          .filter((e) => e.to !== aliasToDelete && e.from !== aliasToDelete)
          .concat(
            prev.filter((e) => e.from === aliasToDelete).map((e) => ({ from: parentAlias, to: e.to }))
          )
      );
    }

    setNodes((prev) => prev.filter((n) => n.id !== aliasToDelete));
    canvasEdited.current = true;
    setHasUnsavedChanges(true);
    setSelectedNode(null);
    setNodeDataRows(null);
  }

  // ── Column picker confirm → apply INNER join ─────────────────────────────

  function handleColumnPickerConfirm(leftCol: string, rightCol: string) {
    const { pendingJoinNodeId, leftTable, rightTable } = columnPickerConfig;
    const condition = `${leftTable}.${leftCol} = ${rightTable}.${rightCol}`;
    setNodes((prev) =>
      prev.map((n) =>
        n.id === pendingJoinNodeId
          ? { ...n, right_input: rightTable, join_type: "inner", condition }
          : n
      )
    );
    setEdges((prev) => [...prev, { from: rightTable, to: pendingJoinNodeId }]);
    setColumnPickerConfig((p) => ({ ...p, isOpen: false }));
    canvasEdited.current = true;
    setHasUnsavedChanges(true);
  }

  // ── Node select → show data profiler ─────────────────────────────────────

  // Trace upstream through edges to find the nearest source node's table name
  function traceToSourceTable(nodeId: string, visited = new Set<string>()): string | null {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return null;
    if (n.type === "source") return (n.table as string) || null;
    const parentEdge = edges.find((e) => e.to === nodeId);
    if (!parentEdge) return null;
    return traceToSourceTable(parentEdge.from, visited);
  }

  async function handleNodeSelect(node: PrepNodeData | null) {
    setSelectedNode(node);
    if (!node) { setNodeDataRows(null); return; }

    // Join node → show type-switcher AND fetch data if join is complete

    setTimeout(() => previewDrawerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);

    const connId = (currentFlow?.connection_id as string) || selectedConnectionId;
    if (!connId) { setNodeDataRows(null); return; }

    const isMcpFlow = !canvasEdited.current;

    // ── MCP-created flow: only output node has runnable SQL ──────────────────
    if (isMcpFlow) {
      if (node.type !== "output" && node.type !== "source") {
        // Internal node — no per-node SQL available from MCP
        setNodeDataRows([{ __mcp_message: "This flow was created by MCP. Per-node preview is not available. Click the Output node to see final results." }]);
        return;
      }
      // Source node in MCP flow → sample raw table
      if (node.type === "source") {
        setIsLoadingNodeData(true);
        try {
          const tableName = (node.details?.table as string) || node.label;
          const schemaName = (node.details?.schema as string) || undefined;
          const res = await api.sampleTable(actorEmail, connId, tableName, schemaName, 50);
          setNodeDataRows(res?.rows?.length ? res.rows : null);
        } catch { setNodeDataRows(null); }
        finally { setIsLoadingNodeData(false); }
        return;
      }
      // Output node in MCP flow → run the saved flow SQL
      if (currentFlow?.flow_id) {
        setIsLoadingNodeData(true);
        try {
          const res = await api.runBackendFlow(actorEmail, currentFlow.flow_id as string);
          setNodeDataRows(res?.rows?.length ? res.rows : null);
        } catch { setNodeDataRows(null); }
        finally { setIsLoadingNodeData(false); }
      }
      return;
    }

    // ── Manual / edited flow: execute per-node SQL from nodeSQL map ──────────
    const nodeKey = (node.alias as string) || (node.id as string) || "";
    const nodeSQLEntry = nodeSQL[nodeKey] ?? nodeSQL[node.id as string];

    if (node.type === "source" && !nodeSQLEntry) {
      // Source with no compiled SQL yet → sample raw table
      setIsLoadingNodeData(true);
      try {
        const tableName = (node.details?.table as string) || node.label;
        const schemaName = (node.details?.schema as string) || undefined;
        const res = await api.sampleTable(actorEmail, connId, tableName, schemaName, 50);
        setNodeDataRows(res?.rows?.length ? res.rows : null);
      } catch { setNodeDataRows(null); }
      finally { setIsLoadingNodeData(false); }
      return;
    }

    if (!nodeSQLEntry) { setNodeDataRows(null); return; }

    setIsLoadingNodeData(true);
    try {
      const res = await api.queryConnection(actorEmail, connId, nodeSQLEntry, 50);
      setNodeDataRows(res?.rows?.length ? res.rows : null);
    } catch { setNodeDataRows(null); }
    finally { setIsLoadingNodeData(false); }
  }

  // ── Save checkpoint ───────────────────────────────────────────────────────

  async function handleSaveCheckpoint(summary?: string) {
    if (!currentFlow) return;
    setIsSavingCheckpoint(true);
    setError(null);
    try {
      const changeSummary = summary || `Saved (${new Date().toLocaleTimeString()})`;
      // Persist live flow state
      await api.updateFlow(actorEmail, currentFlow.flow_id as string, { nodes, edges, sql });
      // Save versioned checkpoint
      await api.saveCheckpoint(actorEmail, currentFlow.flow_id as string, { nodes, edges, sql, change_summary: changeSummary });
      setHasUnsavedChanges(false);
      if (isHistoryModalOpen) {
        const cps = await api.listCheckpoints(actorEmail, currentFlow.flow_id as string);
        setCheckpoints(cps as unknown as Checkpoint[]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save checkpoint");
    } finally {
      setIsSavingCheckpoint(false);
    }
  }

  // ── Version history ───────────────────────────────────────────────────────

  async function handleOpenHistoryModal() {
    if (!currentFlow) return;
    setIsHistoryModalOpen(true);
    const cps = await api.listCheckpoints(actorEmail, currentFlow.flow_id as string);
    setCheckpoints(cps as unknown as Checkpoint[]);
  }

  async function handleRestoreCheckpoint(cpId: string) {
    if (!currentFlow) return;
    try {
      const restored = await api.restoreCheckpoint(actorEmail, currentFlow.flow_id as string, cpId) as any;
      setCurrentFlow(restored);
      setNodes(restored.nodes || []);
      setEdges(restored.edges || []);
      setSql(restored.sql || "");
      setHasUnsavedChanges(false);
      const cps = await api.listCheckpoints(actorEmail, currentFlow.flow_id as string);
      setCheckpoints(cps as unknown as Checkpoint[]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to restore checkpoint");
    }
  }

  // ── Keyboard shortcut Ctrl+S ──────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (hasUnsavedChanges && currentFlow) handleSaveCheckpoint();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasUnsavedChanges, currentFlow, nodes, edges, sql]);

  // ── Auto-build SQL from canvas nodes (manual flows only) ─────────────────

  useEffect(() => {
    if (!canvasEdited.current) return; // skip on initial load — preserves MCP SQL
    if (nodes.length === 0) { setSql(""); setNodeSQL({}); return; }
    const result: FlowSQLResult = buildFlowSQL(nodes, edges, buildColumnMap(), 1000);
    setSql(result.sql);
    setNodeSQL(result.nodeSQL);
  }, [nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Run flow ──────────────────────────────────────────────────────────────

  async function handleRunFlow() {
    if (!currentFlow) return;
    setIsRunning(true);
    setError(null);
    setPublishSuccess(null);
    try {
      // Auto-save unsaved changes before running
      if (hasUnsavedChanges) {
        await api.updateFlow(actorEmail, currentFlow.flow_id as string, { nodes, edges, sql });
        setHasUnsavedChanges(false);
      }
      const result = await api.runBackendFlow(actorEmail, currentFlow.flow_id as string);
      if (!result.ok) {
        setError(result.error || "Run failed");
        return;
      }
      const rows = result.rows || [];
      if (rows.length > 0) {
        setNodeDataRows(rows);
        setSelectedNode({
          label: "Output (Transformed Data)",
          type: "output",
          alias: "output",
          description: `${result.row_count ?? rows.length} rows produced`,
        } as PrepNodeData);
        setTimeout(() => previewDrawerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Run execution failed");
    } finally {
      setIsRunning(false);
    }
  }

  // ── Publish (generate Hyper) ──────────────────────────────────────────────

  async function handlePublish() {
    if (!currentFlow) return;
    setIsPublishing(true);
    setError(null);
    setPublishSuccess(null);
    try {
      if (hasUnsavedChanges) {
        await api.updateFlow(actorEmail, currentFlow.flow_id as string, { nodes, edges, sql });
        setHasUnsavedChanges(false);
      }
      const result = await api.executeBackendFlow(actorEmail, currentFlow.flow_id as string);
      if (!result.ok) { setError(result.error || "Publish failed"); return; }
      const hyper = result.hyper as any;
      setPublishSuccess(`Hyper extract written: ${hyper?.file_path || "outputs/hyper/"} (${result.row_count ?? 0} rows)`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Publish failed");
    } finally {
      setIsPublishing(false);
    }
  }

  // ── Derived canvas data ───────────────────────────────────────────────────

  const backendFlow: BackendFlow | undefined = currentFlow
    ? {
        flow_id: currentFlow.flow_id as string,
        name: currentFlow.name as string,
        connection_id: (currentFlow.connection_id as string) || selectedConnectionId,
        sql,
        nodes,
        edges,
      }
    : undefined;

  const hasCanvas = nodes.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="w-full flex flex-col min-h-screen px-2 sm:px-4 py-2 space-y-3 pb-16">
      {/* Header */}
      <div className="w-full flex flex-wrap items-center justify-between bg-white border border-slate-200 px-4 py-2.5 rounded-lg shadow-xs gap-3 shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <span className="p-2 bg-gradient-to-tr from-blue-600 to-indigo-600 text-white rounded-lg shadow-sm">
              <Sparkles className="w-4 h-4" />
            </span>
            <div>
              <h1 className="text-sm font-bold text-slate-900 leading-tight">
                {currentFlow ? (currentFlow.name as string) : "Tableau AI Prep Studio"}
              </h1>
              <span className="text-[11px] text-slate-500">Visual Flow Canvas</span>
            </div>
          </div>

          {/* Connection selector */}
          <div className="flex items-center gap-2 border-l border-slate-200 pl-4">
            <Database className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={selectedConnectionId}
              onChange={(e) => setSelectedConnectionId(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-300 rounded px-2.5 py-1 text-slate-700 font-medium focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="">Select source database...</option>
              {connections.filter((c) => c.type !== "tableau_server").map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
              ))}
            </select>
            <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv,.xlsx,.xls,.json,.txt" className="hidden" />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingFile}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded transition-colors cursor-pointer shadow-2xs"
            >
              {isUploadingFile ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              {isUploadingFile ? "Uploading..." : "Upload File"}
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {/* Save Checkpoint */}
          {currentFlow && (
            <button
              onClick={() => handleSaveCheckpoint()}
              disabled={isSavingCheckpoint || (!hasUnsavedChanges)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all cursor-pointer shadow-2xs ${
                hasUnsavedChanges
                  ? "bg-amber-500 hover:bg-amber-600 text-white animate-pulse"
                  : "bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 disabled:opacity-50"
              }`}
              title="Save Checkpoint (Ctrl+S)"
            >
              {isSavingCheckpoint ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {hasUnsavedChanges ? "Save Checkpoint *" : "Saved"}
            </button>
          )}

          {/* History */}
          {currentFlow && (
            <button
              onClick={handleOpenHistoryModal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg cursor-pointer shadow-2xs"
              title="Version history & checkpoints"
            >
              <History className="w-3.5 h-3.5 text-slate-500" />
              History
            </button>
          )}

          {/* Run */}
          <button
            onClick={handleRunFlow}
            disabled={!currentFlow || isRunning || isFlowLoading}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg disabled:opacity-40 transition-all cursor-pointer shadow-sm"
          >
            {isRunning || isFlowLoading
              ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              : <Play className="w-3.5 h-3.5 fill-current" />}
            {isFlowLoading ? "Loading..." : isRunning ? "Running..." : "Run Flow"}
          </button>

          {/* Export CSV */}
          <button
            onClick={() => exportToCsv(nodeDataRows, `${(currentFlow?.name as string) || "export"}.csv`)}
            disabled={!nodeDataRows?.length}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-40 transition-all cursor-pointer shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>

          {/* Publish */}
          <button
            onClick={handlePublish}
            disabled={!currentFlow || isPublishing || isRunning}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-40 transition-all cursor-pointer shadow-sm"
          >
            <CloudUpload className="w-3.5 h-3.5" />
            {isPublishing ? "Publishing..." : "Publish to Tableau"}
          </button>

          {/* Toggle sidebar */}
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border rounded-lg transition-all cursor-pointer shadow-xs ${
              isSidebarOpen ? "bg-slate-800 border-slate-900 text-white" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            <Database className="w-3.5 h-3.5" />
            {isSidebarOpen ? "Hide Tables" : "Show Tables"}
          </button>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-700 bg-red-50 border border-red-200 px-4 py-2.5 rounded-lg shrink-0">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {publishSuccess && (
        <div className="flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 px-4 py-2.5 rounded-lg shrink-0">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{publishSuccess}</span>
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-12 gap-4 items-start">
        {/* Left sidebar: tables */}
        {isSidebarOpen && (
          <div className="col-span-12 lg:col-span-3 xl:col-span-2 bg-white border border-slate-200 rounded-xl flex flex-col h-[486px] overflow-hidden shadow-xs">
            <div className="p-3 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-slate-600" />
                Tables
                <span className="text-[10px] px-1.5 py-0.5 bg-slate-200/80 text-slate-700 font-semibold rounded-full">
                  {databaseTables.length}
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    if (!selectedConnectionId) return;
                    setIsLoadingTables(true);
                    api.getConnectionSchema(actorEmail, selectedConnectionId, true)
                      .then((res) => setDatabaseTables(res.tables || []))
                      .catch(console.error)
                      .finally(() => setIsLoadingTables(false));
                  }}
                  disabled={isLoadingTables || !selectedConnectionId}
                  className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingTables ? "animate-spin text-blue-500" : ""}`} />
                </button>
                <button onClick={() => setIsSidebarOpen(false)} className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600 cursor-pointer">
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="p-2.5 border-b border-slate-100 bg-white">
              <div className="relative">
                <Search className="w-3 h-3 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text" value={tableSearch} onChange={(e) => setTableSearch(e.target.value)}
                  placeholder="Search tables..."
                  className="w-full text-[11px] bg-slate-50 border border-slate-200 rounded-lg pl-8 pr-2.5 py-1.5 focus:outline-none focus:border-blue-500 font-medium"
                />
              </div>
            </div>

            <div className="flex-1 p-2 overflow-y-auto space-y-1.5 text-xs">
              {isLoadingTables ? (
                <div className="flex flex-col items-center justify-center h-36 text-slate-400 gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-blue-500" />
                  <span className="text-[11px]">Loading schema...</span>
                </div>
              ) : databaseTables.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-36 text-center px-4 text-slate-400">
                  <Database className="w-6 h-6 mb-1.5 text-slate-300" />
                  <span className="text-[11px] font-medium text-slate-600">No tables found</span>
                  <span className="text-[10px] text-slate-400 mt-0.5">
                    {selectedConnectionId ? "Database has no accessible tables" : "Select a connection above"}
                  </span>
                </div>
              ) : (
                databaseTables
                  .filter((t) => t.name.toLowerCase().includes(tableSearch.toLowerCase()))
                  .map((table) => {
                    const isAdded = nodes.some((n) => n.type === "source" && n.table === table.name);
                    return (
                      <div
                        key={table.name}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/tableau-table", table.name);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        className={`group p-2 rounded-lg border transition-all select-none cursor-grab active:cursor-grabbing ${
                          isAdded
                            ? "bg-blue-50/50 border-blue-200 text-blue-900"
                            : "bg-slate-50/60 hover:bg-white border-slate-200/80 hover:border-slate-300 text-slate-800"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 overflow-hidden">
                            <Table className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span className="font-semibold text-xs truncate" title={table.name}>{table.name}</span>
                          </div>
                          <button
                            onClick={() => handleAddTableToCanvas(table.name, table.schema || "main")}
                            className={`p-1 rounded cursor-pointer transition-colors ${
                              isAdded
                                ? "bg-blue-200/70 text-blue-800 hover:bg-blue-300"
                                : "bg-white hover:bg-blue-600 hover:text-white border border-slate-200 text-slate-600 shadow-2xs"
                            }`}
                            title={isAdded ? "Inspect table" : "Add table to canvas"}
                          >
                            {isAdded ? <CheckCircle2 className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-500 mt-1 pl-5">
                          <span>{table.columns ? `${table.columns.length} columns` : "Table"}</span>
                          <span className="text-[9px] text-slate-400 group-hover:text-blue-500">drag to canvas</span>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        )}

        {/* Canvas */}
        <div className={`${isSidebarOpen ? "col-span-12 lg:col-span-9 xl:col-span-10" : "col-span-12"} transition-all duration-300`}>
          <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-xs">
            {hasCanvas ? (
              <VisualFlowCanvas
                backendFlow={backendFlow}
                onNodeSelect={handleNodeSelect}
                onTableDrop={(tbl) => handleAddTableToCanvas(tbl)}
                onConnectNodes={handleConnectNodes}
                onAddStepOnEdge={handleAddStepOnEdge}
                onAddStepFromNode={handleAddStepFromNode}
                onDeleteStep={handleDeleteStep}
                className="h-[460px]"
              />
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                onDrop={(e) => { e.preventDefault(); const tbl = e.dataTransfer.getData("application/tableau-table"); if (tbl) handleAddTableToCanvas(tbl); }}
                className="w-full h-[460px] border border-dashed border-slate-300 rounded-xl flex flex-col items-center justify-center p-8 text-center bg-slate-50/50 hover:border-blue-400 hover:bg-blue-50/20 transition-all cursor-pointer"
              >
                <div className="p-4 bg-white border border-slate-200 rounded-full shadow-xs mb-3 text-slate-400">
                  <Sparkles className="w-8 h-8 text-blue-500" />
                </div>
                <h3 className="text-base font-semibold text-slate-800">Your Visual Flow Canvas is Blank</h3>
                <p className="text-xs text-slate-500 max-w-md mt-1 leading-relaxed">
                  Drag any table from the sidebar on the left and drop it here, or click <span className="font-semibold text-slate-700">+</span> on a table to add it to your flow.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Data profiler drawer */}
      {selectedNode && (
        <div
          ref={previewDrawerRef}
          className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t-2 border-blue-500 shadow-2xl transition-all duration-300 max-h-[50vh] flex flex-col animate-in slide-in-from-bottom-5"
        >
          <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 bg-slate-50/90 backdrop-blur shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="p-1.5 bg-blue-100 text-blue-700 rounded-md"><Eye className="w-4 h-4" /></span>
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  Profile: {selectedNode.label}
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 uppercase">{selectedNode.type}</span>
                </h3>
                <p className="text-[11px] text-slate-500">{selectedNode.description || selectedNode.alias} • Live distribution & sample rows</p>
              </div>
            </div>
            <button
              onClick={() => handleNodeSelect(null)}
              className="text-xs text-slate-600 hover:text-slate-900 flex items-center gap-1.5 cursor-pointer bg-white hover:bg-slate-100 border border-slate-300 px-3 py-1.5 rounded-lg shadow-xs font-medium"
            >
              <X className="w-3.5 h-3.5" /> Close
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Join type switcher — shown instead of profiler for join nodes */}
            {selectedNode.type === "join" ? (() => {
              const joinNode = nodes.find((n) => n.id === selectedNode.alias);
              const currentType = (joinNode?.join_type as string) || "inner";
              const condition = (joinNode?.condition as string) || "";
              const JOIN_TYPES = [
                { id: "inner", label: "Inner Join", desc: "Matching rows only" },
                { id: "left",  label: "Left Join",  desc: "All left + matches" },
                { id: "right", label: "Right Join", desc: "All right + matches" },
                { id: "full",  label: "Full Outer",  desc: "All rows from both" },
              ];
              return (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold text-slate-700 mb-2">Join Type</p>
                    <div className="flex flex-wrap gap-2">
                      {JOIN_TYPES.map((jt) => (
                        <button
                          key={jt.id}
                          type="button"
                          onClick={async () => {
                            const newType = jt.id;
                            const updatedNodes = nodes.map((n) =>
                              n.id === selectedNode.alias ? { ...n, join_type: newType } : n
                            );
                            setNodes(updatedNodes);
                            canvasEdited.current = true;
                            setHasUnsavedChanges(true);
                            // Re-execute join SQL immediately with new type (don't wait for useEffect)
                            const connId = (currentFlow?.connection_id as string) || selectedConnectionId;
                            if (connId) {
                              const result = buildFlowSQL(updatedNodes, edges, buildColumnMap(), 1000);
                              const freshSQL = result.nodeSQL[(selectedNode.alias as string) || (selectedNode.id as string) || ""];
                              if (freshSQL) {
                                setIsLoadingNodeData(true);
                                try {
                                  const res = await api.queryConnection(actorEmail, connId, freshSQL, 50);
                                  setNodeDataRows(res?.rows?.length ? res.rows : null);
                                } catch { setNodeDataRows(null); }
                                finally { setIsLoadingNodeData(false); }
                              }
                            }
                          }}
                          className={`px-4 py-2 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                            currentType === jt.id
                              ? "bg-purple-600 border-purple-600 text-white shadow-sm"
                              : "bg-white border-slate-200 text-slate-700 hover:border-purple-400 hover:bg-purple-50"
                          }`}
                        >
                          <div>{jt.label}</div>
                          <div className={`text-[10px] font-normal mt-0.5 ${currentType === jt.id ? "text-purple-200" : "text-slate-400"}`}>{jt.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                  {condition && (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                      <p className="text-[10px] text-slate-500 font-semibold uppercase tracking-wide mb-1">Join Condition</p>
                      <p className="font-mono text-xs text-slate-800">{condition}</p>
                    </div>
                  )}
                  {joinNode && (!joinNode.right_input) && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs flex items-start gap-2">
                      <span className="text-base leading-none">⟶</span>
                      <span>Draw an edge from this join node&apos;s right handle to a second table, or from a table to this join node — the common column picker will appear.</span>
                    </div>
                  )}
                </div>
              );
            })() : (
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-12 xl:col-span-2">
                <TableauStepChanges node={selectedNode} />
              </div>
              <div className="col-span-12 xl:col-span-10">
                {isLoadingNodeData ? (
                  <div className="p-10 text-center text-xs text-slate-500 flex flex-col items-center gap-2.5 bg-slate-50/50 rounded-xl border border-slate-200">
                    <RefreshCw className="w-5 h-5 animate-spin text-blue-600" />
                    <span className="font-medium">Loading data for {selectedNode.label}...</span>
                  </div>
                ) : (
                  <TableauDataProfiler title={`Field Profile: ${selectedNode.label}`} rows={nodeDataRows} />
                )}
              </div>
            </div>
            )}

            {selectedNode.type !== "join" && nodeDataRows && nodeDataRows.length > 0 && (
              <div className="flex justify-end pt-1">
                <button
                  onClick={() => exportToCsv(nodeDataRows, `${selectedNode.alias || "node"}_data.csv`)}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md cursor-pointer shadow-2xs"
                >
                  <Download className="w-3 h-3" /> Download CSV
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Common column picker — shown when user connects a node to a pending join placeholder */}
      <JoinColumnPicker
        isOpen={columnPickerConfig.isOpen}
        onClose={() => setColumnPickerConfig((p) => ({ ...p, isOpen: false }))}
        leftTable={columnPickerConfig.leftTable}
        rightTable={columnPickerConfig.rightTable}
        leftColumns={columnPickerConfig.leftColumns}
        rightColumns={columnPickerConfig.rightColumns}
        onConfirm={handleColumnPickerConfirm}
      />

      {/* Join modal */}
      <JoinConfigModal
        isOpen={joinModalConfig.isOpen}
        onClose={() => setJoinModalConfig((p) => ({ ...p, isOpen: false }))}
        leftTable={joinModalConfig.leftTable}
        rightTable={joinModalConfig.rightTable}
        leftColumns={joinModalConfig.leftColumns}
        rightColumns={joinModalConfig.rightColumns}
        onConfirmJoin={handleApplyJoin}
        onConfirmUnion={handleApplyUnion}
      />

      {/* Step action modal */}
      <StepActionModal
        isOpen={stepActionModal.isOpen}
        onClose={() => setStepActionModal((p) => ({ ...p, isOpen: false }))}
        sourceAlias={stepActionModal.sourceAlias}
        columns={stepActionModal.columns}
        onApplyStep={handleApplyCustomStep}
        onTriggerJoin={(src) => {
          setStepActionModal((p) => ({ ...p, isOpen: false }));
          // Add placeholder join node — default INNER. User drags second table to it,
          // then clicks the join node to pick join type and matching columns.
          const nodeId = `join_${Date.now()}`;
          const newNode: BackendNode = {
            id: nodeId, type: "join", name: nodeId,
            left_input: src, right_input: "",
            join_type: "inner",
          };
          setNodes((prev) => [...prev, newNode]);
          setEdges((prev) => [...prev, { from: src, to: nodeId }]);
          canvasEdited.current = true;
          setHasUnsavedChanges(true);
        }}
        onTriggerUnion={(src) => {
          setStepActionModal((p) => ({ ...p, isOpen: false }));
          setJoinModalConfig({
            isOpen: true,
            leftTable: src,
            rightTable: "",
            leftColumns: getColumnsForAlias(src),
            rightColumns: [],
          });
        }}
      />

      {/* Version history modal */}
      {isHistoryModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-2xl w-full max-w-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-800">Checkpoints</h3>
              </div>
              <button onClick={() => setIsHistoryModalOpen(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-md hover:bg-slate-100 cursor-pointer">✕</button>
            </div>

            <div className="p-5 max-h-96 overflow-y-auto space-y-3">
              {checkpoints.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">No checkpoints saved yet.</div>
              ) : (
                checkpoints.map((cp) => (
                  <div key={cp.id} className="p-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-between">
                    <div className="space-y-0.5">
                      <span className="font-bold text-xs text-slate-800">Checkpoint v{cp.version_number}</span>
                      <p className="text-[11px] text-slate-500">{cp.change_summary || "Snapshot"}</p>
                      <span className="text-[10px] text-slate-400">{new Date(cp.created_at).toLocaleString()} · {cp.created_by}</span>
                    </div>
                    <button
                      onClick={() => { handleRestoreCheckpoint(cp.id); setIsHistoryModalOpen(false); }}
                      className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                    >
                      Restore
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex justify-end">
              <button onClick={() => setIsHistoryModalOpen(false)} className="px-4 py-1.5 text-xs font-semibold bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg cursor-pointer">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FlowStudioPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-xs text-slate-400">Loading Flow Studio...</div>}>
      <FlowStudioContent />
    </Suspense>
  );
}
