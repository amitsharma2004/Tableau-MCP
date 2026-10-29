"""Connection endpoints — wraps the connector registry."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import create_engine, text
from sqlalchemy import inspect as sa_inspect

from ...connectors.registry import list_connections, get_connection_details, get_connector
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
