"""
MCP tool implementations for database discovery and SQL execution.
Following the LangChain SQL-agent tool pattern, adapted for FastMCP.
"""
from __future__ import annotations

import os
from typing import Any

from langsmith import traceable

from ..connectors.registry import (
    get_connector,
    get_connection_details as _get_details,
    list_connections as _list_connections,
)
from ..validation.sql import check_sql


@traceable(name="list_connections", run_type="tool")
def tool_list_connections() -> list[dict]:
    """List all configured connections with safe metadata (no secrets)."""
    return _list_connections()


@traceable(name="get_connection_details", run_type="tool")
def tool_get_connection_details(connection_id: str) -> dict:
    """Return safe config details for a connection."""
    try:
        return _get_details(connection_id)
    except KeyError as exc:
        return {"error": str(exc)}


@traceable(name="test_connection", run_type="tool")
def tool_test_connection(connection_id: str) -> dict:
    """Check whether a connection is reachable."""
    try:
        with get_connector(connection_id) as conn:
            ok = conn.test_connection()
        return {"connection_id": connection_id, "reachable": ok}
    except Exception as exc:
        return {"connection_id": connection_id, "reachable": False, "error": str(exc)}


@traceable(name="get_table_overview", run_type="tool")
def tool_get_table_overview(connection_id: str) -> list[dict]:
    """
    Returns all tables in the database with their business descriptions.
    Call this FIRST after list_connections.

    Use the descriptions to decide which tables are relevant to the user's
    query — then call sql_db_schema only for those chosen tables.

    Returns:
        [{"table": "articles", "description": "..."}, ...]
    """
    import json
    from pathlib import Path

    try:
        overview_path = Path(os.getenv("TABLE_OVERVIEW_CONFIG", "config/table_overview.json"))
        if not overview_path.exists():
            raise FileNotFoundError(f"table_overview.json not found at {overview_path}")

        with overview_path.open() as f:
            data = json.load(f)

        # Cross-check against live DB tables
        with get_connector(connection_id) as conn:
            db_tables = set(conn.list_tables())

        descriptions: dict = data.get("tables", {})
        result = []
        for table in sorted(db_tables):
            result.append({
                "table": table,
                "description": descriptions.get(table, "No description available.")
            })
        return result
    except Exception as exc:
        return [{"error": str(exc)}]


@traceable(name="sql_db_schema", run_type="tool")
def tool_sql_db_schema(connection_id: str, table_names: str) -> dict:
    """
    Input: connection_id and a comma-separated list of chosen table names.
    Output: For each chosen table —
      - DDL (column names + types from live DB)
      - Column business descriptions (from metadata, this table only)
      - 3 sample rows

    Only loads metadata for the requested tables — not the full file.

    Example: sql_db_schema("articles_sqlite", "articles, error_logs")
    """
    import json
    from pathlib import Path

    tables = [t.strip() for t in table_names.split(",") if t.strip()]

    # Lazy map: load only requested tables' column descriptions from metadata
    metadata_path = Path(os.getenv("METADATA_CONFIG", "config/database_metadata.json"))
    column_descriptions: dict[str, dict] = {}
    if metadata_path.exists():
        with metadata_path.open() as f:
            full_meta = json.load(f)
        all_tables: dict = full_meta.get("tables", {})
        for table in tables:
            if table in all_tables:
                # Map: column_name → description only
                column_descriptions[table] = {
                    col: meta.get("description", "")
                    for col, meta in all_tables[table].get("columns", {}).items()
                }

    # Fetch DDL + sample rows from live DB
    try:
        with get_connector(connection_id) as conn:
            ddl_text = conn.get_schema(tables)
    except Exception as exc:
        return {"error": str(exc)}

    return {
        "ddl": ddl_text,
        "column_descriptions": column_descriptions,
    }


@traceable(name="sql_db_query_checker", run_type="tool")
def tool_sql_db_query_checker(connection_id: str, query: str) -> str:
    """
    Use this tool to check your SQL query BEFORE executing it.
    Always call this before sql_db_query.

    Checks:
    - Syntax validity (sqlglot AST parse)
    - Blocked statement types (INSERT, UPDATE, DELETE, DROP, etc.)
    - Multi-statement queries
    - Dialect normalisation
    - Common SQLite pitfalls (NOT IN with NULLs, BETWEEN ranges)

    Returns a structured report with status (PASS/FAIL) and the corrected SQL.
    """
    try:
        details = _get_details(connection_id)
        dialect = details.get("type", "sqlite")
        # Map connector type to sqlglot dialect name
        dialect_map = {"sqlite": "sqlite", "mysql": "mysql", "postgresql": "postgres"}
        sqlglot_dialect = dialect_map.get(dialect, "sqlite")
        result = check_sql(query, dialect=sqlglot_dialect)
        return result["report"]
    except Exception as exc:
        return f"Error during query check: {exc}"


@traceable(name="sql_db_query", run_type="tool")
def tool_sql_db_query(connection_id: str, query: str) -> dict[str, Any]:
    """
    Execute a SQL query against the selected connection.
    MUST call sql_db_query_checker first — do not skip this step.

    Returns:
      {"ok": true, "rows": [...], "row_count": N}
      {"ok": false, "error": "..."}

    If you get an error about unknown columns or tables, call
    sql_db_schema to re-inspect and rewrite the query.
    """
    row_limit = int(os.getenv("QUERY_ROW_LIMIT", "1000"))
    try:
        with get_connector(connection_id) as conn:
            # Safety: run checker inline — reject if it fails
            details = _get_details(connection_id)
            dialect_map = {"sqlite": "sqlite", "mysql": "mysql", "postgresql": "postgres"}
            dialect = dialect_map.get(details.get("type", "sqlite"), "sqlite")
            check = check_sql(query, dialect=dialect)
            if not check["ok"]:
                return {"ok": False, "error": f"Query blocked by checker: {check['report']}"}
            rows = conn.execute_query(check["corrected_sql"], row_limit=row_limit)
        return {"ok": True, "rows": rows, "row_count": len(rows)}
    except Exception as exc:
        # Sanitise — don't leak internal paths or credentials
        msg = str(exc)
        if "password" in msg.lower() or "secret" in msg.lower():
            msg = "Database connection error (details redacted)."
        return {"ok": False, "error": msg}
