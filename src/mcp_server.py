"""
MCP server — exposes tools to Claude Desktop via stdio.

Claude Desktop call order:
  1. list_connections       → pick connection
  2. get_table_overview     → see table descriptions, choose relevant tables
  3. get_schema             → column details + sample rows for chosen tables only
  4. run_query              → check SQL with sqlglot, then execute
  5. generate_output        → validate plan, produce Flow JSON + optional Hyper extract

Run:
    python -m src.mcp_server

Claude Desktop config (claude_desktop_config.json):
    {
      "mcpServers": {
        "sql-compiler": {
          "command": "python3",
          "args": ["-m", "src.mcp_server"],
          "cwd": "/path/to/SQL Compilor"
        }
      }
    }
"""
from __future__ import annotations

from dotenv import load_dotenv
load_dotenv()

try:
    from mcp.server.fastmcp import FastMCP
except ModuleNotFoundError:
    from mcp.server.mcpserver import MCPServer as FastMCP  # mcp 2.x

from .tools.database_tools import (
    tool_list_connections,
    tool_get_table_overview,
    tool_sql_db_schema,
    tool_sql_db_query_checker,
    tool_sql_db_query,
)
from .tools.validation_tools import (
    tool_validate_table_selection,
    tool_validate_flow_plan,
)
from .tools.output_tools import (
    tool_generate_flow_json,
    tool_generate_hyper_extract,
)
from .store.db import init_db
from .store.crud import save_flow, save_query_run, save_hyper_extract

# Initialise SQLite store on import so both MCP and API share the same schema
try:
    init_db()
except Exception:
    pass  # non-fatal — store may not be available in all environments

mcp = FastMCP("sql-compiler")


# ── Tool 1 ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def list_connections() -> list[dict]:
    """
    List all configured database connections.
    Call this first to get the connection_id to use in subsequent tools.

    Returns: [{"connection_id": "...", "type": "sqlite", "display_name": "..."}, ...]
    """
    return tool_list_connections()


# ── Tool 2 ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def get_table_overview(connection_id: str) -> list[dict]:
    """
    Returns all tables with their business descriptions — no column details.
    Call this second, after list_connections.

    Use the descriptions to decide which tables are needed for the user's query.
    Then call get_schema with only those chosen tables.

    Returns: [{"table": "articles", "description": "..."}, ...]
    """
    return tool_get_table_overview(connection_id)


# ── Tool 3 ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def get_schema(connection_id: str, table_names: str) -> dict:
    """
    Returns DDL, column business descriptions, and sample rows for the chosen tables ONLY.
    Call this third, after get_table_overview — pass only the tables relevant to the query.

    Args:
        connection_id: The selected connection.
        table_names: Comma-separated list of chosen tables (e.g. "articles, error_logs").

    Returns:
        {
          "ddl": "CREATE TABLE articles (...) ...",
          "column_descriptions": {
            "articles": {"jid": "Journal ID...", "stage": "Processing stage..."},
            "error_logs": {"error_from": "Pipeline step where error originated..."}
          }
        }
    """
    return tool_sql_db_schema(connection_id, table_names)


# ── Tool 4 ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def run_query(connection_id: str, sql: str) -> dict:
    """
    Validates and executes a SQL SELECT query in one call.

    Internally:
      1. Runs sqlglot AST check (syntax, blocked statements, dialect issues)
      2. If check passes, executes the query
      3. If check fails, returns the error — rewrite the SQL and try again

    Only SELECT is permitted. Results capped at 1000 rows.

    Returns:
        {"ok": true,  "rows": [...], "row_count": N}
        {"ok": false, "error": "..."}
    """
    check = tool_sql_db_query_checker(connection_id, sql)
    if "FAIL" in check:
        return {"ok": False, "error": check}
    return tool_sql_db_query(connection_id, sql)


# ── Tool 5 ─────────────────────────────────────────────────────────────────────

@mcp.tool()
def generate_output(
    connection_id: str,
    plan: dict,
    rows: list[dict],
    name: str = "",
    generate_hyper: bool = False,
) -> dict:
    """
    Validates the flow plan and produces all outputs in one call.

    Internally:
      1. Validates that plan tables exist in the live DB
      2. Validates plan structure (unique IDs, no cycles, output node present)
      3. Generates Flow JSON from the validated plan
      4. Optionally generates a Tableau Hyper extract from the query rows

    Args:
        connection_id: The selected connection (used for table validation).
        plan: The flow plan dict with "nodes", "edges", "sql", "connection_id".
              nodes must include source tables, transformations, and an output node.
        rows: The row list returned by run_query — used for Hyper extract.
        name: Display name for the flow (optional).
        generate_hyper: Set true to also write a .hyper extract file.

    Returns:
        {
          "ok": true,
          "flow_json": {...},
          "hyper": {"ok": true, "path": "...", "row_count": N}  # only if generate_hyper=true
          "validation_errors": [],
          "frontend_url": "http://localhost:3000/flows/<flow_id>"  # share this link with the user
        }
    """
    errors: list[str] = []

    # 1. Validate tables exist in live DB
    source_tables = [
        n.get("table") for n in plan.get("nodes", [])
        if n.get("type") == "source" and n.get("table")
    ]
    if source_tables:
        table_check = tool_validate_table_selection(connection_id, source_tables)
        if not table_check["ok"]:
            errors.append(f"Missing tables: {table_check['missing']}")

    # 2. Validate plan structure
    plan_check = tool_validate_flow_plan(plan)
    if not plan_check["ok"]:
        errors.extend(plan_check["errors"])

    if errors:
        return {"ok": False, "validation_errors": errors, "flow_json": None, "hyper": None}

    # 3. Generate Flow JSON
    flow_result = tool_generate_flow_json(plan, name=name or None)
    if not flow_result["ok"]:
        return {"ok": False, "validation_errors": [flow_result["error"]], "flow_json": None, "hyper": None}

    result = {
        "ok": True,
        "validation_errors": [],
        "flow_json": flow_result["flow_json"],
        "hyper": None,
    }

    # 4. Optionally generate Hyper extract
    if generate_hyper:
        result["hyper"] = tool_generate_hyper_extract(rows)

    # 5. Persist to SQLite store so the frontend REST API can read it
    try:
        fj = result["flow_json"]
        save_flow(
            flow_id=fj["flow_id"],
            name=fj.get("name", "Untitled Flow"),
            connection_id=fj.get("connection_id", connection_id),
            sql=fj.get("sql", ""),
            nodes=fj.get("nodes", []),
            edges=fj.get("edges", []),
            source_tables=[
                n.get("table") for n in fj.get("nodes", [])
                if n.get("type") == "source" and n.get("table")
            ],
        )
        if rows:
            save_query_run(
                flow_id=fj["flow_id"],
                sql=fj.get("sql", ""),
                rows=rows,
                row_count=len(rows),
                status="ok",
            )
        if result.get("hyper") and result["hyper"].get("ok"):
            save_hyper_extract(
                flow_id=fj["flow_id"],
                file_path=result["hyper"]["path"],
                row_count=result["hyper"]["row_count"],
            )
        import os
        frontend_base = os.getenv("FRONTEND_URL", "http://localhost:3000")
        result["frontend_url"] = f"{frontend_base}/flows/new?flowId={fj['flow_id']}"
    except Exception as _store_err:
        result["store_warning"] = f"Could not persist to store: {_store_err}"

    return result


if __name__ == "__main__":
    mcp.run(transport="stdio")
