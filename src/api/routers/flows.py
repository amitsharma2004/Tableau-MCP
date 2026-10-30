"""Flow endpoints — CRUD, checkpoints, run, execute."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ...store import crud
from ...connectors.registry import get_connector, get_connection_details
from ...validation.sql import check_sql
from ...outputs import hyper_extract as hyper_mod
from ..deps import get_actor

router = APIRouter(prefix="/flows", tags=["flows"])


# ── Request bodies ───────────────────────────────────────────────────────────

class CreateFlowBody(BaseModel):
    name: str
    connection_id: str

class PatchFlowBody(BaseModel):
    nodes: list
    edges: list
    sql: str


class CheckpointBody(BaseModel):
    nodes: list
    edges: list
    sql: str
    change_summary: str | None = None


# ── Flow CRUD ────────────────────────────────────────────────────────────────

@router.post("")
def create_flow(body: CreateFlowBody, actor: str = Depends(get_actor)):
    """Create a new empty flow (called when user first drags a table to canvas)."""
    flow_id = str(uuid.uuid4())
    flow = crud.save_flow(
        flow_id=flow_id,
        name=body.name,
        connection_id=body.connection_id,
        sql="",
        nodes=[],
        edges=[],
        source_tables=[],
    )
    return flow


@router.get("")
def list_flows(actor: str = Depends(get_actor)):
    return crud.list_flows()


@router.get("/{flow_id}")
def get_flow(flow_id: str, actor: str = Depends(get_actor)):
    flow = crud.get_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    return flow


@router.patch("/{flow_id}")
def update_flow(flow_id: str, body: PatchFlowBody, actor: str = Depends(get_actor)):
    """Update the live nodes/edges of a flow (canvas edits)."""
    flow = crud.get_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    updated = crud.update_flow_nodes(flow_id, body.nodes, body.edges, body.sql)
    return updated


# ── Checkpoints ──────────────────────────────────────────────────────────────

@router.get("/{flow_id}/checkpoints")
def list_checkpoints(flow_id: str, actor: str = Depends(get_actor)):
    return crud.list_checkpoints(flow_id)


@router.post("/{flow_id}/checkpoints")
def save_checkpoint(flow_id: str, body: CheckpointBody, actor: str = Depends(get_actor)):
    """Save a named checkpoint of the current canvas state."""
    flow = crud.get_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    cp = crud.save_checkpoint(
        flow_id,
        body.nodes,
        body.edges,
        body.sql,
        change_summary=body.change_summary,
        created_by=actor,
    )
    return cp


@router.post("/{flow_id}/checkpoints/{cp_id}/restore")
def restore_checkpoint(flow_id: str, cp_id: str, actor: str = Depends(get_actor)):
    """Restore a checkpoint as the active flow state."""
    result = crud.restore_checkpoint(flow_id, cp_id)
    if not result:
        raise HTTPException(status_code=404, detail="Checkpoint not found")
    return result


# ── Run (execute SQL, store results) ────────────────────────────────────────

@router.post("/{flow_id}/run")
def run_flow(flow_id: str, actor: str = Depends(get_actor)):
    """
    Validate and execute the flow's SQL against the live database.
    Stores results in query_runs table.
    """
    flow = crud.get_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")

    sql = flow["sql"]
    if not sql or not sql.strip():
        return {"ok": False, "run": None,
                "error": "No SQL for this flow. Add a table to the canvas first."}

    connection_id = flow["connection_id"]

    # sqlglot check
    details = get_connection_details(connection_id)
    dialect_map = {"sqlite": "sqlite", "mysql": "mysql", "postgresql": "postgres"}
    dialect = dialect_map.get(details.get("type", "sqlite"), "sqlite")
    check = check_sql(sql, dialect=dialect)
    if not check["ok"]:
        run = crud.save_query_run(
            flow_id, sql, [], 0,
            status="failed",
            error=f"SQL check failed: {check['report']}",
        )
        return {"ok": False, "run": run, "error": check["report"]}

    # Execute
    row_limit = 1000
    try:
        with get_connector(connection_id) as conn:
            rows = conn.execute_query(check["corrected_sql"], row_limit=row_limit)
        run = crud.save_query_run(flow_id, sql, rows, len(rows), status="ok")
        return {"ok": True, "run": run, "rows": rows, "row_count": len(rows)}
    except Exception as exc:
        run = crud.save_query_run(flow_id, sql, [], 0, status="failed", error=str(exc))
        return {"ok": False, "run": run, "error": str(exc)}


@router.get("/{flow_id}/run/latest")
def latest_run(flow_id: str, actor: str = Depends(get_actor)):
    """Return the most recent query run for a flow."""
    run = crud.latest_query_run(flow_id)
    if not run:
        raise HTTPException(status_code=404, detail="No runs found")
    return run


# ── Execute (generate Hyper extract) ────────────────────────────────────────

@router.post("/{flow_id}/execute")
def execute_flow(flow_id: str, actor: str = Depends(get_actor)):
    """
    Run the SQL and generate a Tableau Hyper extract.
    Uses the latest query run rows if available, otherwise re-runs the SQL.
    """
    flow = crud.get_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")

    # Get rows — re-run if no cached run
    latest = crud.latest_query_run(flow_id)
    if latest and latest["status"] == "ok" and latest["rows"]:
        rows = latest["rows"]
    else:
        # Run fresh
        run_result = run_flow(flow_id, actor)
        if not run_result.get("ok"):
            return run_result
        rows = run_result["rows"]

    # Generate Hyper
    import os
    from datetime import datetime, timezone
    output_dir = os.getenv("HYPER_OUTPUT_DIR", "outputs/hyper")
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    output_path = os.path.join(output_dir, f"{flow_id[:8]}_{ts}.hyper")
    hyper_result = hyper_mod.generate_hyper(rows, output_path)

    if hyper_result.get("ok"):
        extract = crud.save_hyper_extract(
            flow_id,
            hyper_result["path"],
            hyper_result["row_count"],
        )
        return {"ok": True, "hyper": extract, "row_count": hyper_result["row_count"]}
    else:
        return {"ok": False, "error": hyper_result.get("error")}


# ── Calcite SQL compilation ───────────────────────────────────────────────────

class CompileSQLBody(BaseModel):
    dialect: str
    connection_id: str
    nodes: list           # sub-graph for Calcite compilation (ancestor nodes only)
    edges: list
    flow_id: str | None = None          # when set, auto-save a checkpoint
    change_summary: str | None = None
    flow_nodes: list | None = None      # full canvas nodes — used for checkpoint
    flow_edges: list | None = None      # full canvas edges — used for checkpoint


@router.post("/compile-sql")
def compile_sql(body: CompileSQLBody, actor: str = Depends(get_actor)):
    """Translate a flow sub-graph JSON into optimized SQL via Apache Calcite.

    nodes/edges  — sub-graph for compilation (ancestor nodes of clicked node).
    flow_nodes/flow_edges — full canvas graph, saved in the checkpoint so the
                            checkpoint always reflects the complete flow state.
    """
    try:
        from ...calcite import compile_flow  # noqa: PLC0415
    except ImportError as exc:
        raise HTTPException(
            status_code=501,
            detail=f"Calcite module unavailable: {exc}",
        )
    try:
        sql = compile_flow(
            nodes=body.nodes,
            edges=body.edges,
            dialect=body.dialect,
            connection_id=body.connection_id,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    checkpoint = None
    if body.flow_id:
        flow = crud.get_flow(body.flow_id)
        if flow:
            # Use full canvas graph for checkpoint when provided; fall back to sub-graph
            cp_nodes = body.flow_nodes if body.flow_nodes is not None else body.nodes
            cp_edges = body.flow_edges if body.flow_edges is not None else body.edges
            summary = body.change_summary or f"SQL compiled ({len(cp_nodes)} nodes)"
            checkpoint = crud.save_checkpoint(
                body.flow_id,
                cp_nodes,
                cp_edges,
                sql,
                change_summary=summary,
                created_by=actor,
            )
            # Also keep the flow row's sql in sync
            crud.update_flow_nodes(body.flow_id, cp_nodes, cp_edges, sql)

    return {"sql": sql, "checkpoint": checkpoint}
