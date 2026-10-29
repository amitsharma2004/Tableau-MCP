"""CRUD operations for the SQLite store."""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone

from .db import get_conn


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(conn: sqlite3.Connection, table: str, pk_col: str, pk_val: str) -> dict | None:
    row = conn.execute(f"SELECT * FROM {table} WHERE {pk_col} = ?", (pk_val,)).fetchone()
    return dict(row) if row else None


# ── Flows ───────────────────────────────────────────────────────────────────

def save_flow(
    flow_id: str,
    name: str,
    connection_id: str,
    sql: str,
    nodes: list,
    edges: list,
    source_tables: list,
    schema_version: str = "1.0",
) -> dict:
    """Insert or replace a flow record. Called by generate_output MCP tool."""
    conn = get_conn()
    now = _now()
    with conn:
        existing = _row(conn, "flows", "flow_id", flow_id)
        if existing:
            conn.execute(
                """UPDATE flows SET name=?, sql=?, nodes_json=?, edges_json=?,
                   source_tables_json=?, updated_at=? WHERE flow_id=?""",
                (name, sql, json.dumps(nodes), json.dumps(edges),
                 json.dumps(source_tables), now, flow_id),
            )
        else:
            conn.execute(
                """INSERT INTO flows (flow_id, schema_version, name, connection_id,
                   sql, nodes_json, edges_json, source_tables_json, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (flow_id, schema_version, name, connection_id,
                 sql, json.dumps(nodes), json.dumps(edges),
                 json.dumps(source_tables), now, now),
            )
    conn.close()
    return get_flow(flow_id)


def get_flow(flow_id: str) -> dict | None:
    conn = get_conn()
    row = _row(conn, "flows", "flow_id", flow_id)
    conn.close()
    if not row:
        return None
    return _deserialize_flow(row)


def list_flows() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM flows ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [_deserialize_flow(dict(r)) for r in rows]


def update_flow_nodes(flow_id: str, nodes: list, edges: list, sql: str) -> dict | None:
    conn = get_conn()
    with conn:
        conn.execute(
            "UPDATE flows SET nodes_json=?, edges_json=?, sql=?, updated_at=? WHERE flow_id=?",
            (json.dumps(nodes), json.dumps(edges), sql, _now(), flow_id),
        )
    conn.close()
    return get_flow(flow_id)


def _deserialize_flow(row: dict) -> dict:
    row["nodes"] = json.loads(row.pop("nodes_json", "[]"))
    row["edges"] = json.loads(row.pop("edges_json", "[]"))
    row["source_tables"] = json.loads(row.pop("source_tables_json", "[]"))
    return row


# ── Checkpoints ─────────────────────────────────────────────────────────────

def save_checkpoint(
    flow_id: str,
    nodes: list,
    edges: list,
    sql: str,
    change_summary: str | None = None,
    created_by: str = "user",
) -> dict:
    conn = get_conn()
    # next version number
    row = conn.execute(
        "SELECT COALESCE(MAX(version_number), 0) as v FROM checkpoints WHERE flow_id=?",
        (flow_id,),
    ).fetchone()
    version = (row["v"] if row else 0) + 1
    cp_id = str(uuid.uuid4())
    now = _now()
    with conn:
        conn.execute(
            """INSERT INTO checkpoints (id, flow_id, version_number, nodes_json,
               edges_json, sql, change_summary, created_at, created_by)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (cp_id, flow_id, version, json.dumps(nodes), json.dumps(edges),
             sql, change_summary, now, created_by),
        )
    conn.close()
    return get_checkpoint(cp_id)


def get_checkpoint(cp_id: str) -> dict | None:
    conn = get_conn()
    row = _row(conn, "checkpoints", "id", cp_id)
    conn.close()
    if not row:
        return None
    return _deserialize_checkpoint(row)


def list_checkpoints(flow_id: str) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM checkpoints WHERE flow_id=? ORDER BY version_number DESC",
        (flow_id,),
    ).fetchall()
    conn.close()
    return [_deserialize_checkpoint(dict(r)) for r in rows]


def restore_checkpoint(flow_id: str, cp_id: str) -> dict | None:
    """Restores checkpoint to live flow and saves a new checkpoint marking the restore."""
    cp = get_checkpoint(cp_id)
    if not cp:
        return None
    update_flow_nodes(flow_id, cp["nodes"], cp["edges"], cp["sql"])
    save_checkpoint(
        flow_id, cp["nodes"], cp["edges"], cp["sql"],
        change_summary=f"Restored from checkpoint v{cp['version_number']}",
    )
    return get_flow(flow_id)


def _deserialize_checkpoint(row: dict) -> dict:
    row["nodes"] = json.loads(row.pop("nodes_json", "[]"))
    row["edges"] = json.loads(row.pop("edges_json", "[]"))
    return row


# ── Query runs ──────────────────────────────────────────────────────────────

def save_query_run(
    flow_id: str,
    sql: str,
    rows: list,
    row_count: int,
    status: str = "ok",
    error: str | None = None,
) -> dict:
    conn = get_conn()
    run_id = str(uuid.uuid4())
    now = _now()
    with conn:
        conn.execute(
            """INSERT INTO query_runs (id, flow_id, sql, rows_json, row_count,
               status, error, executed_at) VALUES (?,?,?,?,?,?,?,?)""",
            (run_id, flow_id, sql, json.dumps(rows, default=str),
             row_count, status, error, now),
        )
    conn.close()
    return get_query_run(run_id)


def get_query_run(run_id: str) -> dict | None:
    conn = get_conn()
    row = _row(conn, "query_runs", "id", run_id)
    conn.close()
    if not row:
        return None
    return _deserialize_run(row)


def latest_query_run(flow_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM query_runs WHERE flow_id=? ORDER BY executed_at DESC LIMIT 1",
        (flow_id,),
    ).fetchone()
    conn.close()
    return _deserialize_run(dict(row)) if row else None


def _deserialize_run(row: dict) -> dict:
    row["rows"] = json.loads(row.pop("rows_json", "[]"))
    return row


# ── Hyper extracts ──────────────────────────────────────────────────────────

def save_hyper_extract(flow_id: str, file_path: str, row_count: int) -> dict:
    conn = get_conn()
    ext_id = str(uuid.uuid4())
    now = _now()
    with conn:
        conn.execute(
            "INSERT INTO hyper_extracts (id, flow_id, file_path, row_count, created_at) VALUES (?,?,?,?,?)",
            (ext_id, flow_id, file_path, row_count, now),
        )
    conn.close()
    row = get_conn().execute("SELECT * FROM hyper_extracts WHERE id=?", (ext_id,)).fetchone()
    return dict(row)


def latest_hyper_extract(flow_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM hyper_extracts WHERE flow_id=? ORDER BY created_at DESC LIMIT 1",
        (flow_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None
