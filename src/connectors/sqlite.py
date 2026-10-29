from pathlib import Path
from typing import Any

import sqlglot
import sqlglot.errors
from sqlalchemy import create_engine, inspect, text

from .base import DatabaseConnector

_BLOCKED = {"insert", "update", "delete", "drop", "alter", "create", "truncate", "replace"}


class SQLiteConnector(DatabaseConnector):
    def __init__(self, config: dict) -> None:
        db_path = Path(config["path"])
        self._engine = create_engine(f"sqlite:///{db_path}", connect_args={"timeout": 10})
        self._dialect = "sqlite"

    def test_connection(self) -> bool:
        try:
            with self._engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            return True
        except Exception:
            return False

    def list_tables(self) -> list[str]:
        insp = inspect(self._engine)
        return sorted(insp.get_table_names())

    def get_schema(self, tables: list[str]) -> str:
        insp = inspect(self._engine)
        valid = set(insp.get_table_names())
        parts: list[str] = []
        with self._engine.connect() as conn:
            for table in tables:
                if table not in valid:
                    parts.append(f"-- ERROR: table {table!r} not found")
                    continue
                cols = insp.get_columns(table)
                col_defs = ", ".join(f"{c['name']} {c['type']}" for c in cols)
                ddl = f"CREATE TABLE {table} ({col_defs})"
                parts.append(ddl)
                try:
                    quoted = f'"{table}"'
                    rows = conn.execute(text(f"SELECT * FROM {quoted} LIMIT 3")).fetchall()
                    if rows:
                        headers = "\t".join(c["name"] for c in cols)
                        body = "\n".join("\t".join(str(v) for v in r) for r in rows)
                        parts.append(f"/*\n3 rows from {table}:\n{headers}\n{body}\n*/")
                except Exception as exc:
                    parts.append(f"/* sample rows error: {exc} */")
        return "\n\n".join(parts)

    def check_query(self, sql: str) -> tuple[bool, str]:
        # Block destructive statements
        try:
            statements = sqlglot.parse(sql, dialect=self._dialect)
        except sqlglot.errors.ParseError as exc:
            return False, f"Parse error: {exc}"

        for stmt in statements:
            if stmt is None:
                continue
            kind = stmt.key.lower()
            if kind in _BLOCKED:
                return False, f"Statement type {kind.upper()} is not permitted."

        # Transpile to normalize and catch dialect issues
        try:
            normalized = sqlglot.transpile(sql, read=self._dialect, write=self._dialect, pretty=False)
            return True, normalized[0] if normalized else sql
        except sqlglot.errors.SqlglotError as exc:
            return False, f"Dialect error: {exc}"

    def execute_query(self, sql: str, row_limit: int = 1000) -> list[dict[str, Any]]:
        with self._engine.connect() as conn:
            result = conn.execute(text(sql))
            keys = list(result.keys())
            rows = result.fetchmany(row_limit)
        return [dict(zip(keys, row)) for row in rows]

    def close(self) -> None:
        self._engine.dispose()
