"""Column-level lineage check — verifies table/column references against live DB schema."""
from __future__ import annotations

from ..connectors.registry import get_connector


def validate_table_selection(connection_id: str, tables: list[str]) -> dict:
    """
    Verify that every proposed table exists in the database.
    Returns {"ok": bool, "missing": [...], "found": [...]}.
    """
    with get_connector(connection_id) as conn:
        available = set(conn.list_tables())

    missing = [t for t in tables if t not in available]
    found = [t for t in tables if t in available]
    return {"ok": len(missing) == 0, "missing": missing, "found": found}


def validate_columns(connection_id: str, table_columns: dict[str, list[str]]) -> dict:
    """
    Verify columns exist in their respective tables.
    table_columns: {"table_name": ["col1", "col2"], ...}
    Returns {"ok": bool, "errors": [...]}
    """
    errors: list[str] = []
    with get_connector(connection_id) as conn:
        schema_text = conn.get_schema(list(table_columns.keys()))

    # Build a simple column map from schema text (DDL lines)
    # For a more robust approach we use the inspector via connector
    with get_connector(connection_id) as conn:
        from sqlalchemy import inspect as sa_inspect
        insp = sa_inspect(conn._engine)  # type: ignore[attr-defined]
        for table, cols in table_columns.items():
            try:
                db_cols = {c["name"] for c in insp.get_columns(table)}
            except Exception:
                errors.append(f"Could not inspect table {table!r}")
                continue
            for col in cols:
                if col not in db_cols:
                    errors.append(f"Column {col!r} not found in table {table!r}")

    return {"ok": len(errors) == 0, "errors": errors}
