"""sqlglot-based SQL validation with LangChain prompt template for the checker report."""
from langchain_core.prompts import PromptTemplate

import sqlglot
import sqlglot.errors

_BLOCKED = {"insert", "update", "delete", "drop", "alter", "create", "truncate", "replace"}

# Prompt template for formatting the checker report back to Claude Desktop
_CHECKER_REPORT_TEMPLATE = PromptTemplate(
    input_variables=["query", "status", "message"],
    template=(
        "SQL Check Result\n"
        "================\n"
        "Original query:\n{query}\n\n"
        "Status: {status}\n"
        "Detail: {message}"
    ),
)


def check_sql(sql: str, dialect: str = "sqlite") -> dict:
    """
    Validate and normalise SQL using sqlglot.
    Returns a dict with keys: ok (bool), corrected_sql (str), report (str).
    """
    # 1. Parse
    try:
        statements = sqlglot.parse(sql, dialect=dialect)
    except sqlglot.errors.ParseError as exc:
        report = _CHECKER_REPORT_TEMPLATE.format(
            query=sql, status="FAIL", message=f"Parse error: {exc}"
        )
        return {"ok": False, "corrected_sql": sql, "report": report}

    # 2. Block destructive statements
    for stmt in statements:
        if stmt is None:
            continue
        kind = stmt.key.lower()
        if kind in _BLOCKED:
            msg = f"Statement type {kind.upper()} is not permitted. Only SELECT is allowed."
            report = _CHECKER_REPORT_TEMPLATE.format(query=sql, status="FAIL", message=msg)
            return {"ok": False, "corrected_sql": sql, "report": report}

    # 3. Check for multi-statement (only one SELECT allowed per call)
    non_null = [s for s in statements if s is not None]
    if len(non_null) > 1:
        msg = "Multiple statements in a single query are not permitted."
        report = _CHECKER_REPORT_TEMPLATE.format(query=sql, status="FAIL", message=msg)
        return {"ok": False, "corrected_sql": sql, "report": report}

    # 4. Transpile to normalise
    try:
        normalized = sqlglot.transpile(sql, read=dialect, write=dialect, pretty=True)
        corrected = normalized[0] if normalized else sql
    except sqlglot.errors.SqlglotError as exc:
        msg = f"Dialect transpile error: {exc}"
        report = _CHECKER_REPORT_TEMPLATE.format(query=sql, status="FAIL", message=msg)
        return {"ok": False, "corrected_sql": sql, "report": report}

    # 5. Warn about common SQLite pitfalls in the report
    warnings: list[str] = []
    sql_upper = sql.upper()
    if "NOT IN" in sql_upper:
        warnings.append("NOT IN with NULLs returns no rows — consider NOT EXISTS instead.")
    if "BETWEEN" in sql_upper:
        warnings.append("BETWEEN is inclusive on both ends; verify range intent.")

    status = "PASS" + (" (with warnings)" if warnings else "")
    detail = "\n".join(warnings) if warnings else "No issues found."
    report = _CHECKER_REPORT_TEMPLATE.format(query=corrected, status=status, message=detail)
    return {"ok": True, "corrected_sql": corrected, "report": report}
