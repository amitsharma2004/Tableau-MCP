"""Connection endpoints — wraps the connector registry."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy import inspect as sa_inspect

from ...connectors.registry import list_connections, get_connection_details, get_connector, _CONNECTIONS_CONFIG
import json
import os
import re
from pathlib import Path
from ...validation.sql import check_sql
from ..deps import get_actor

router = APIRouter(prefix="/connections", tags=["connections"])


def _build_engine(connection_id: str):
    details = get_connection_details(connection_id)
    db_type = details.get("type", "sqlite")
    if db_type == "sqlite":
        db_path = details.get("path") or details.get("database", "")
        return create_engine(f"sqlite:///{db_path}")
    if db_type == "mysql":
        host = details.get("host", "localhost")
        port = details.get("port", 3306)
        db   = details.get("database", "")
        user = details.get("username", "")
        pw   = details.get("password", "")
        return create_engine(f"mysql+pymysql://{user}:{pw}@{host}:{port}/{db}")
    if db_type == "postgresql":
        host = details.get("host", "localhost")
        port = details.get("port", 5432)
        db   = details.get("database", "")
        user = details.get("username", "")
        pw   = details.get("password", "")
        return create_engine(f"postgresql+psycopg2://{user}:{pw}@{host}:{port}/{db}")
    raise ValueError(f"Unsupported db type: {db_type}")


@router.get("")
def list_conns(actor: str = Depends(get_actor)):
    """List all configured connections with safe metadata."""
    raw = list_connections()
    return [
        {
            "id":                   c["connection_id"],
            "name":                 c.get("display_name", c["connection_id"]),
            "type":                 c.get("type", "sqlite"),
            "host":                 None,
            "port":                 None,
            "database_name":        c.get("database", None),
            "username":             None,
            "is_read_only":         True,
            "tableau_site_id":      None,
            "tableau_project_id":   None,
            "created_by":           actor,
            "created_at":           "",
            "updated_at":           "",
        }
        for c in raw
    ]


@router.post("/{connection_id}/test")
def test_conn(connection_id: str, actor: str = Depends(get_actor)):
    try:
        with get_connector(connection_id) as conn:
            ok = conn.test_connection()
        return {"connected": ok, "is_read_only": True, "tables": []}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{connection_id}/schema")
def get_schema(
    connection_id: str,
    force_refresh: bool = Query(default=False),
    actor: str = Depends(get_actor),
):
    """Return all tables with column names and types via SQLAlchemy inspect."""
    try:
        engine = _build_engine(connection_id)
        inspector = sa_inspect(engine)
        tables = []
        for table_name in inspector.get_table_names():
            cols = inspector.get_columns(table_name)
            tables.append({
                "name":    table_name,
                "schema":  "main",
                "columns": [
                    {
                        "name":      c["name"],
                        "data_type": str(c["type"]),
                        "nullable":  c.get("nullable", True),
                    }
                    for c in cols
                ],
            })
        engine.dispose()
        return {"connected": True, "is_read_only": True, "tables": tables}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class QueryRequest(BaseModel):
    sql: str
    limit: int = 50


@router.post("/{connection_id}/query")
def query_connection(
    connection_id: str,
    req: QueryRequest,
    actor: str = Depends(get_actor),
):
    """Execute a read-only SQL query and return rows. Used for per-node previews."""
    details = get_connection_details(connection_id)
    dialect_map = {"sqlite": "sqlite", "mysql": "mysql", "postgresql": "postgres"}
    dialect = dialect_map.get(details.get("type", "sqlite"), "sqlite")
    check = check_sql(req.sql, dialect=dialect)
    if not check["ok"]:
        raise HTTPException(status_code=400, detail=check["report"])
    try:
        with get_connector(connection_id) as conn:
            rows = conn.execute_query(check["corrected_sql"], row_limit=min(req.limit, 200))
        return {"rows": rows, "row_count": len(rows)}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{connection_id}/sample")
def sample_table(
    connection_id: str,
    table: str = Query(...),
    schema: str = Query(default=None),
    limit: int = Query(default=50, le=200),
    actor: str = Depends(get_actor),
):
    """Return sample rows from a table."""
    try:
        engine = _build_engine(connection_id)
        with engine.connect() as con:
            result = con.execute(text(f"SELECT * FROM {table} LIMIT :lim"), {"lim": limit})
            rows = [dict(r._mapping) for r in result]
        engine.dispose()
        return {"rows": rows}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ── Helpers ──────────────────────────────────────────────────────────────────

def _config_path() -> Path:
    return Path(os.getenv("CONNECTIONS_CONFIG", "config/connections.json"))

def _read_config() -> dict:
    p = _config_path()
    if not p.exists():
        return {"connections": {}}
    with p.open() as f:
        return json.load(f)

def _write_config(data: dict) -> None:
    p = _config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w") as f:
        json.dump(data, f, indent=2)
    # Clear registry cache so next load picks up the change
    import src.connectors.registry as reg
    reg._CONNECTIONS_CONFIG.clear()

def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


# ── Create connection ─────────────────────────────────────────────────────────

class CreateConnectionBody(BaseModel):
    name: str
    type: str          # postgres | mysql | sqlite
    host: str = ""
    port: int = 0
    database_name: str = ""
    username: str = ""
    secret: str = ""

@router.post("")
def create_connection(body: CreateConnectionBody, actor: str = Depends(get_actor)):
    """Save a new connection to connections.json."""
    data = _read_config()
    connections = data.setdefault("connections", {})

    # Build a unique connection_id from the name
    base = _slugify(body.name) or "conn"
    cid = base
    suffix = 1
    while cid in connections:
        cid = f"{base}_{suffix}"
        suffix += 1

    if body.type == "sqlite":
        entry = {
            "type": "sqlite",
            "display_name": body.name,
            "path": body.database_name,
        }
    elif body.type == "mysql":
        entry = {
            "type": "mysql",
            "display_name": body.name,
            "host": body.host,
            "port": body.port or 3306,
            "database": body.database_name,
            "username": body.username,
            "password": body.secret,
        }
    elif body.type in ("postgres", "postgresql"):
        entry = {
            "type": "postgresql",
            "display_name": body.name,
            "host": body.host,
            "port": body.port or 5432,
            "database": body.database_name,
            "username": body.username,
            "password": body.secret,
        }
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported type: {body.type}")

    connections[cid] = entry
    _write_config(data)

    return {
        "id": cid,
        "name": body.name,
        "type": entry["type"],
        "host": body.host or None,
        "port": body.port or None,
        "database_name": body.database_name,
        "username": body.username or None,
        "is_read_only": True,
    }


# ── Delete connection ─────────────────────────────────────────────────────────

@router.delete("/{connection_id}")
def delete_connection(connection_id: str, actor: str = Depends(get_actor)):
    """Remove a connection from connections.json."""
    data = _read_config()
    connections = data.get("connections", {})
    if connection_id not in connections:
        raise HTTPException(status_code=404, detail=f"Connection not found: {connection_id}")
    del connections[connection_id]
    _write_config(data)
    return {"deleted": connection_id}
