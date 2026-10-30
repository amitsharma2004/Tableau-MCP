"""Build a Calcite SchemaPlus from structured column metadata."""
from __future__ import annotations


# ── Type mapping ─────────────────────────────────────────────────────────────

def _calcite_type(data_type: str):
    """Map a SQLAlchemy/SQL type string to a Calcite SqlTypeName."""
    from org.apache.calcite.sql.type import SqlTypeName  # noqa: PLC0415

    dt = data_type.upper()
    if any(k in dt for k in ("INT", "NUMERIC", "DECIMAL", "NUMBER")):
        return SqlTypeName.DECIMAL
    if any(k in dt for k in ("FLOAT", "REAL", "DOUBLE")):
        return SqlTypeName.DOUBLE
    if "BOOL" in dt:
        return SqlTypeName.BOOLEAN
    if "TIMESTAMP" in dt or "DATETIME" in dt:
        return SqlTypeName.TIMESTAMP
    if "DATE" in dt:
        return SqlTypeName.DATE
    if "TIME" in dt:
        return SqlTypeName.TIME
    if any(k in dt for k in ("BLOB", "BYTES", "BINARY", "BYTEA")):
        return SqlTypeName.VARBINARY
    return SqlTypeName.VARCHAR  # safe default


# ── Table proxy (defined at module level so JPype registers it once) ──────────

def _make_table_class():
    """Return a JImplements proxy class for org.apache.calcite.schema.Table."""
    import jpype
    from org.apache.calcite.schema import Schema, Statistics  # noqa: PLC0415

    @jpype.JImplements("org.apache.calcite.schema.Table")
    class _TableImpl:
        def __init__(self, col_defs: list[dict]) -> None:
            self._col_defs = col_defs

        @jpype.JOverride
        def getRowType(self, typeFactory):
            builder = typeFactory.builder()
            for col in self._col_defs:
                sql_type = _calcite_type(col.get("data_type", "TEXT"))
                # createTypeWithNullability(type, true) marks columns as nullable
                # so IS NOT NULL / IS NULL filters are not optimized away
                nullable_type = typeFactory.createTypeWithNullability(
                    typeFactory.createSqlType(sql_type), True
                )
                builder.add(col["name"], nullable_type)
            return builder.build()

        @jpype.JOverride
        def getStatistic(self):
            return Statistics.UNKNOWN

        @jpype.JOverride
        def getJdbcTableType(self):
            return Schema.TableType.TABLE

        @jpype.JOverride
        def isRolledUp(self, column):
            return False

        @jpype.JOverride
        def rolledUpColumnValidInsideAgg(self, column, call, parent, config):
            return True

    return _TableImpl


_TableClass = None  # cached after first JVM start


# ── Schema builder ────────────────────────────────────────────────────────────

def build_root_schema(table_columns: dict[str, list[dict]]):
    """
    Build a Calcite SchemaPlus from table column metadata.

    table_columns: { table_name: [{"name": str, "data_type": str}, ...] }
    Returns a Calcite SchemaPlus with each table registered.
    """
    global _TableClass
    from org.apache.calcite.tools import Frameworks  # noqa: PLC0415

    if _TableClass is None:
        _TableClass = _make_table_class()

    root = Frameworks.createRootSchema(True)
    for table_name, columns in table_columns.items():
        root.add(table_name, _TableClass(list(columns)))

    return root
