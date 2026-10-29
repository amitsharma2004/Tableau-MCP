"""Generate a Tableau Hyper extract from a validated SQL query."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _map_type(python_value: Any):
    """Map a Python value to a tableauhyperapi SqlType."""
    from tableauhyperapi import SqlType
    if isinstance(python_value, int):
        return SqlType.big_int()
    if isinstance(python_value, float):
        return SqlType.double()
    return SqlType.text()


def generate_hyper(
    rows: list[dict[str, Any]],
    output_path: str,
    table_name: str = "Extract",
    schema_name: str = "Extract",
) -> dict:
    """
    Write rows to a .hyper file.

    Args:
        rows: List of dicts from sql_db_query.
        output_path: Destination .hyper file path.
        table_name: Hyper table name.
        schema_name: Hyper schema name.

    Returns:
        {"ok": bool, "path": str, "row_count": int, "error": str | None}
    """
    if not rows:
        return {"ok": False, "path": output_path, "row_count": 0, "error": "No rows to write."}

    try:
        from tableauhyperapi import (
            HyperProcess,
            Telemetry,
            Connection,
            CreateMode,
            TableName,
            TableDefinition,
            SqlType,
            Inserter,
        )
    except ImportError:
        return {
            "ok": False,
            "path": output_path,
            "row_count": 0,
            "error": "tableauhyperapi is not installed. Run: pip install 'tableauhyperapi'",
        }

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    # Infer schema from first row
    sample = rows[0]
    columns = [
        TableDefinition.Column(col, _map_type(val))
        for col, val in sample.items()
    ]

    hyper_table = TableName(schema_name, table_name)
    table_def = TableDefinition(hyper_table, columns)

    try:
        with HyperProcess(telemetry=Telemetry.DO_NOT_SEND_USAGE_DATA_TO_TABLEAU) as hyper:
            with Connection(
                hyper.endpoint, str(out), CreateMode.CREATE_AND_REPLACE
            ) as connection:
                connection.catalog.create_schema_if_not_exists(schema_name)
                connection.catalog.create_table_if_not_exists(table_def)
                with Inserter(connection, table_def) as inserter:
                    for row in rows:
                        inserter.add_row([row[c.name.unescaped] for c in columns])
                    inserter.execute()
        return {"ok": True, "path": str(out.resolve()), "row_count": len(rows), "error": None}
    except Exception as exc:
        if out.exists():
            out.unlink()
        return {"ok": False, "path": output_path, "row_count": 0, "error": str(exc)}
