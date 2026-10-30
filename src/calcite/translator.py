"""Translate flow plan JSON → Calcite RelNode → SQL string."""
from __future__ import annotations

from .jvm import ensure_jvm
from .schema import build_root_schema


# ── Dialect mapping ───────────────────────────────────────────────────────────

def _get_dialect(dialect: str):
    from org.apache.calcite.sql.dialect import (  # noqa: PLC0415
        MysqlSqlDialect,
        PostgresqlSqlDialect,
        AnsiSqlDialect,
    )
    d = dialect.lower()
    if d == "mysql":
        return MysqlSqlDialect.DEFAULT
    if d in ("postgresql", "postgres"):
        return PostgresqlSqlDialect.DEFAULT
    # SQLite is close to ANSI; use AnsiSqlDialect
    return AnsiSqlDialect.DEFAULT


# ── Schema fetch ──────────────────────────────────────────────────────────────

def _fetch_table_columns(
    source_nodes: list[dict], connection_id: str
) -> dict[str, list[dict]]:
    """Return {table_name: [{name, data_type}, ...]} via SQLAlchemy inspect."""
    from sqlalchemy import inspect as sa_inspect  # noqa: PLC0415
    from ..connectors.registry import get_connection_details  # noqa: PLC0415

    details = get_connection_details(connection_id)
    db_type = details.get("type", "sqlite")

    if db_type == "sqlite":
        from sqlalchemy import create_engine  # noqa: PLC0415
        engine = create_engine(f"sqlite:///{details.get('path', details.get('database', ''))}")
    elif db_type == "mysql":
        h, p, db = details.get("host", "localhost"), details.get("port", 3306), details.get("database", "")
        u, pw = details.get("username", ""), details.get("password", "")
        engine = create_engine(f"mysql+pymysql://{u}:{pw}@{h}:{p}/{db}")
    elif db_type in ("postgresql", "postgres"):
        h, p, db = details.get("host", "localhost"), details.get("port", 5432), details.get("database", "")
        u, pw = details.get("username", ""), details.get("password", "")
        engine = create_engine(f"postgresql+psycopg2://{u}:{pw}@{h}:{p}/{db}")
    else:
        return {}

    inspector = sa_inspect(engine)
    result: dict[str, list[dict]] = {}
    for node in source_nodes:
        table = node.get("table") or node["id"]
        try:
            cols = inspector.get_columns(table)
            result[table] = [{"name": c["name"], "data_type": str(c["type"])} for c in cols]
        except Exception:
            result[table] = []
    engine.dispose()
    return result


# ── Graph helpers ─────────────────────────────────────────────────────────────

def _build_adj(edges: list[dict]) -> tuple[dict, dict]:
    edges_to: dict[str, list[str]] = {}   # node → parents
    edges_from: dict[str, list[str]] = {} # node → children
    for e in edges:
        edges_to.setdefault(e["to"], []).append(e["from"])
        edges_from.setdefault(e["from"], []).append(e["to"])
    return edges_to, edges_from


def _downstream_path(
    start_id: str, by_id: dict, edges_from: dict, skip_types: set[str]
) -> list[dict]:
    """Walk forward (downstream) from start_id, returning nodes in order."""
    path: list[dict] = []
    cur_id: str | None = (edges_from.get(start_id) or [None])[0]
    seen: set[str] = set()
    while cur_id and cur_id not in seen:
        seen.add(cur_id)
        node = by_id.get(cur_id)
        if node and node.get("type") not in skip_types:
            path.append(node)
        children = edges_from.get(cur_id, [])
        cur_id = children[0] if children else None
    return path


def _linear_path(terminal_id: str, by_id: dict, edges_to: dict) -> list[dict]:
    path: list[dict] = []
    cur_id: str | None = terminal_id
    seen: set[str] = set()
    while cur_id and cur_id not in seen:
        seen.add(cur_id)
        if cur_id in by_id:
            path.insert(0, by_id[cur_id])
        parents = edges_to.get(cur_id, [])
        cur_id = parents[0] if parents else None
    return path


# ── Clean-op translators ──────────────────────────────────────────────────────

def _apply_filter(op: dict, builder) -> None:
    from org.apache.calcite.sql.fun import SqlStdOperatorTable  # noqa: PLC0415

    op_map = {
        "=":           SqlStdOperatorTable.EQUALS,
        "!=":          SqlStdOperatorTable.NOT_EQUALS,
        ">":           SqlStdOperatorTable.GREATER_THAN,
        "<":           SqlStdOperatorTable.LESS_THAN,
        ">=":          SqlStdOperatorTable.GREATER_THAN_OR_EQUAL,
        "<=":          SqlStdOperatorTable.LESS_THAN_OR_EQUAL,
        "LIKE":        SqlStdOperatorTable.LIKE,
    }
    conditions = op.get("conditions", [])
    known = {str(f) for f in builder.peek().getRowType().getFieldNames()}
    rex_list = []
    for cond in conditions:
        col, operator, val = cond.get("column"), cond.get("operator"), cond.get("value")
        if col not in known:
            continue  # skip condition referencing unknown column (empty schema fallback)
        field = builder.field(col)
        if operator == "is_null":
            rex_list.append(builder.call(SqlStdOperatorTable.IS_NULL, field))
        elif operator == "is_not_null":
            rex_list.append(builder.call(SqlStdOperatorTable.IS_NOT_NULL, field))
        else:
            literal = builder.literal(val)
            sql_op = op_map.get(operator, SqlStdOperatorTable.EQUALS)
            rex_list.append(builder.call(sql_op, field, literal))

    if not rex_list:
        return
    logic = op.get("logic", "AND")
    if len(rex_list) == 1:
        combined = rex_list[0]
    elif logic == "OR":
        combined = builder.call(SqlStdOperatorTable.OR, *rex_list)
    else:
        combined = builder.call(SqlStdOperatorTable.AND, *rex_list)
    builder.filter(combined)


def _apply_rename(op: dict, builder) -> None:
    mapping: dict[str, str] = op.get("mapping", {})
    if not mapping:
        return
    field_list = list(builder.peek().getRowType().getFieldList())
    # Access by index — after a JOIN, Calcite suffixes duplicate column names
    # (id→id0, created_at→created_at0) and builder.field(name) cannot resolve
    # those suffixed names. Index access is always safe.
    exprs = [builder.field(i) for i in range(len(field_list))]
    orig_names = [str(field_list[i].getName()) for i in range(len(field_list))]
    aliases = [mapping.get(name, name) for name in orig_names]
    builder.project(exprs, aliases, True)


def _apply_calculate(op: dict, builder) -> None:
    """Add a calculated column. Expression is treated as a SQL literal for now;
    full RexNode parsing requires a Calcite SQL parser round-trip (future work)."""
    name = op.get("name", "calc")
    expr_str = op.get("expression", "NULL")
    existing_names = [str(f) for f in builder.peek().getRowType().getFieldNames()]
    existing_fields = [builder.field(n) for n in existing_names]
    # Wrap expression as an uninterpreted SQL call using AS-literal trick
    # Real implementation should parse expr_str via SqlParser → RexNode
    new_expr = builder.literal(expr_str)   # placeholder until parser is wired
    exprs = existing_fields + [new_expr]
    aliases = existing_names + [name]
    builder.project(exprs, aliases, True)


def _apply_dedup(op: dict, builder) -> None:
    builder.distinct()


def _apply_clean(node: dict, builder) -> None:
    for op in node.get("operations", []):
        kind = op.get("op")
        if kind == "filter_values":
            _apply_filter(op, builder)
        elif kind == "rename":
            _apply_rename(op, builder)
        elif kind == "calculate":
            _apply_calculate(op, builder)
        elif kind == "dedup":
            _apply_dedup(op, builder)


# ── Standalone node handlers ──────────────────────────────────────────────────

def _apply_aggregate(node: dict, builder) -> None:
    known = {str(f) for f in builder.peek().getRowType().getFieldNames()}

    group_by: list[str] = node.get("group_by") or []
    group_keys = [builder.field(c) for c in group_by if c in known]

    aggregations = node.get("aggregations") or []
    agg_calls = []
    for agg in aggregations:
        col = agg.get("column", "*")
        func = (agg.get("func") or agg.get("function") or "count").lower()
        alias = agg.get("alias", f"{func}_{col}")
        if col == "*" or col not in known:
            agg_calls.append(builder.countStar(alias))
        elif func == "count":
            agg_calls.append(builder.count(False, alias, builder.field(col)))
        elif func == "sum":
            agg_calls.append(builder.sum(False, alias, builder.field(col)))
        elif func == "avg":
            agg_calls.append(builder.avg(False, alias, builder.field(col)))
        elif func == "min":
            agg_calls.append(builder.min(alias, builder.field(col)))
        elif func == "max":
            agg_calls.append(builder.max(alias, builder.field(col)))
        else:
            agg_calls.append(builder.countStar(alias))

    if group_keys or agg_calls:
        # Unpack as *args to avoid JPype overload ambiguity
        builder.aggregate(builder.groupKey(*group_keys), *agg_calls)


def _apply_sort(node: dict, builder) -> None:
    known = {str(f) for f in builder.peek().getRowType().getFieldNames()}
    order_by: list[dict] = node.get("order_by") or []
    sort_fields = []
    for item in order_by:
        col = item.get("column", "")
        if col not in known:
            continue
        direction = (item.get("direction") or "ASC").upper()
        sort_fields.append(
            builder.desc(builder.field(col)) if direction == "DESC" else builder.field(col)
        )
    if sort_fields:
        builder.sort(*sort_fields)


def _apply_select_columns(node: dict, builder) -> None:
    columns: list[str] = node.get("columns") or []
    known = {str(f) for f in builder.peek().getRowType().getFieldNames()}
    cols = [c for c in columns if c in known]
    if cols:
        exprs = [builder.field(c) for c in cols]
        builder.project(exprs, cols)


def _apply_drop_nulls(node: dict, builder) -> None:
    from org.apache.calcite.sql.fun import SqlStdOperatorTable  # noqa: PLC0415
    columns: list[str] = node.get("columns") or []
    known = {str(f) for f in builder.peek().getRowType().getFieldNames()}
    conditions = [
        builder.call(SqlStdOperatorTable.IS_NOT_NULL, builder.field(c))
        for c in columns if c in known
    ]
    if len(conditions) == 1:
        builder.filter(conditions[0])
    elif len(conditions) > 1:
        builder.filter(builder.call(SqlStdOperatorTable.AND, *conditions))


def _apply_standalone_filter(node: dict, builder) -> None:
    """Handle a standalone 'filter' node (uses same logic as clean→filter_values)."""
    _apply_filter({"conditions": node.get("conditions", []),
                   "logic": node.get("logic", "AND")}, builder)


def _apply_standalone_rename(node: dict, builder) -> None:
    """Handle a standalone 'rename' node — uses 'mappings' (not 'mapping')."""
    _apply_rename({"mapping": node.get("mappings") or node.get("mapping") or {}}, builder)


def _apply_standalone_calculate(node: dict, builder) -> None:
    """Handle a standalone 'calculate' node — uses 'alias' + 'expression' fields."""
    _apply_calculate({"name": node.get("alias", "calc"),
                      "expression": node.get("expression", "NULL")}, builder)


# ── Linear chain ──────────────────────────────────────────────────────────────

def _process_path(path: list[dict], builder) -> None:
    for node in path:
        ntype = node.get("type")
        if ntype == "source":
            builder.scan(node.get("table") or node["id"])
        elif ntype == "clean":
            _apply_clean(node, builder)
        elif ntype == "filter":
            _apply_standalone_filter(node, builder)
        elif ntype == "rename":
            _apply_standalone_rename(node, builder)
        elif ntype == "calculate":
            _apply_standalone_calculate(node, builder)
        elif ntype == "aggregate":
            _apply_aggregate(node, builder)
        elif ntype == "sort":
            _apply_sort(node, builder)
        elif ntype == "select_columns":
            _apply_select_columns(node, builder)
        elif ntype == "drop_nulls":
            _apply_drop_nulls(node, builder)
        elif ntype in ("script", "output"):
            pass  # script runs outside SQL; output is terminal marker


# ── Join ──────────────────────────────────────────────────────────────────────

def _process_join(join_node: dict, by_id: dict, edges_to: dict, builder) -> None:
    from org.apache.calcite.rel.core import JoinRelType  # noqa: PLC0415
    from org.apache.calcite.sql.fun import SqlStdOperatorTable  # noqa: PLC0415

    left_id = join_node.get("left_input", "")
    right_id = join_node.get("right_input", "")

    left_path = _linear_path(left_id, by_id, edges_to)
    right_path = _linear_path(right_id, by_id, edges_to)

    _process_path(left_path, builder)   # pushes left relation
    _process_path(right_path, builder)  # pushes right relation

    jt_str = (join_node.get("join_type") or "inner").upper()
    jt_map = {
        "INNER": JoinRelType.INNER,
        "LEFT":  JoinRelType.LEFT,
        "RIGHT": JoinRelType.RIGHT,
        "FULL":  JoinRelType.FULL,
    }
    join_type = jt_map.get(jt_str, JoinRelType.INNER)

    # Parse condition string "left_node.col = right_node.col"
    condition_str: str = join_node.get("condition", "")
    if condition_str and " = " in condition_str:
        eq_idx = condition_str.index(" = ")
        left_col = condition_str[:eq_idx].strip().rsplit(".", 1)[-1]
        right_col = condition_str[eq_idx + 3:].strip().rsplit(".", 1)[-1]
        # field(inputCount=2, inputIndex, fieldName)
        condition = builder.call(
            SqlStdOperatorTable.EQUALS,
            builder.field(2, 0, left_col),
            builder.field(2, 1, right_col),
        )
    else:
        condition = builder.literal(True)

    builder.join(join_type, condition)


# ── Union ─────────────────────────────────────────────────────────────────────

def _process_union(union_node: dict, by_id: dict, builder) -> None:
    inputs: list[str] = union_node.get("inputs", [])
    count = 0
    for inp_id in inputs:
        inp = by_id.get(inp_id)
        if inp:
            builder.scan(inp.get("table") or inp["id"])
            count += 1
    if count >= 2:
        builder.union(True, count)  # UNION ALL


# ── Main entry point ──────────────────────────────────────────────────────────

def compile_flow(nodes: list[dict], edges: list[dict], dialect: str, connection_id: str) -> str:
    """
    Translate a flow sub-graph JSON into optimized SQL using Apache Calcite.

    nodes / edges: the sub-graph up to the clicked node (from NodeJSONMap).
    dialect:       "sqlite" | "mysql" | "postgresql"
    connection_id: used to fetch live column metadata for schema building.

    Returns a SQL string.
    """
    ensure_jvm()

    from org.apache.calcite.tools import Frameworks, RelBuilder  # noqa: PLC0415
    from org.apache.calcite.rel.rel2sql import RelToSqlConverter  # noqa: PLC0415

    by_id = {n["id"]: n for n in nodes}
    edges_to, edges_from = _build_adj(edges)

    # ── 1. Fetch column metadata for all source tables ────────────────────────
    source_nodes = [n for n in nodes if n.get("type") == "source"]
    try:
        table_columns = _fetch_table_columns(source_nodes, connection_id)
    except Exception:
        # Fallback: empty schemas (Calcite will use ANY type)
        table_columns = {(n.get("table") or n["id"]): [] for n in source_nodes}

    # ── 2. Build Calcite schema ───────────────────────────────────────────────
    root_schema = build_root_schema(table_columns)

    config = (
        Frameworks.newConfigBuilder()
        .defaultSchema(root_schema)
        .build()
    )
    builder = RelBuilder.create(config)

    # ── 3. Build RelNode tree ─────────────────────────────────────────────────
    join_node = next((n for n in nodes if n.get("type") == "join"), None)
    union_node = next((n for n in nodes if n.get("type") == "union"), None)
    output_node = next((n for n in nodes if n.get("type") == "output"), None)

    # Find the terminal node (rightmost leaf, or node just before output)
    if output_node:
        terminal_id = (edges_to.get(output_node["id"]) or [None])[0]
    else:
        leaf = next(
            (n for n in nodes
             if not edges_from.get(n["id"]) and n.get("type") not in ("output",)),
            None,
        )
        terminal_id = leaf["id"] if leaf else (nodes[-1]["id"] if nodes else None)

    if not terminal_id:
        raise ValueError("Cannot determine terminal node in flow plan")

    if join_node:
        # Build the join, then apply any downstream nodes (aggregate, sort, etc.)
        _process_join(join_node, by_id, edges_to, builder)
        post_join = _downstream_path(join_node["id"], by_id, edges_from, skip_types={"output"})
        _process_path(post_join, builder)
    elif union_node:
        _process_union(union_node, by_id, builder)
        post_union = _downstream_path(union_node["id"], by_id, edges_from, skip_types={"output"})
        _process_path(post_union, builder)
    else:
        path = _linear_path(terminal_id, by_id, edges_to)
        _process_path(path, builder)

    rel = builder.build()

    # ── 4. Generate dialect-specific SQL ─────────────────────────────────────
    sql_dialect = _get_dialect(dialect)
    converter = RelToSqlConverter(sql_dialect)
    sql_node = converter.visitRoot(rel).asSelect()
    return str(sql_node.toSqlString(sql_dialect).getSql())
