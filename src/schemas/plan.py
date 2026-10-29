"""Typed models for a transformation plan."""
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class NodeType(str, Enum):
    source = "source"
    join = "join"
    filter = "filter"
    aggregate = "aggregate"
    rename = "rename"
    calculate = "calculate"
    sort = "sort"
    union = "union"
    output = "output"


class JoinType(str, Enum):
    inner = "inner"
    left = "left"
    right = "right"
    full = "full"


class JoinKey(BaseModel):
    left_column: str
    right_column: str


# -- Node variants ----------------------------------------------------------

class SourceNode(BaseModel):
    id: str
    type: Literal[NodeType.source]
    table: str
    columns: list[str] = Field(default_factory=list)  # empty = all columns


class JoinNode(BaseModel):
    id: str
    type: Literal[NodeType.join]
    left_input: str
    right_input: str
    join_type: JoinType = JoinType.inner
    join_keys: list[JoinKey]


class FilterNode(BaseModel):
    id: str
    type: Literal[NodeType.filter]
    input: str
    condition: str  # SQL WHERE expression


class AggregateNode(BaseModel):
    id: str
    type: Literal[NodeType.aggregate]
    input: str
    group_by: list[str]
    aggregations: list[dict[str, str]]  # [{"column": "x", "function": "SUM", "alias": "total_x"}]


class RenameNode(BaseModel):
    id: str
    type: Literal[NodeType.rename]
    input: str
    mappings: dict[str, str]  # {"old_name": "new_name"}


class CalculateNode(BaseModel):
    id: str
    type: Literal[NodeType.calculate]
    input: str
    expression: str   # SQL expression
    alias: str        # output column name


class SortNode(BaseModel):
    id: str
    type: Literal[NodeType.sort]
    input: str
    order_by: list[dict[str, str]]  # [{"column": "x", "direction": "ASC"}]


class UnionNode(BaseModel):
    id: str
    type: Literal[NodeType.union]
    inputs: list[str]
    union_all: bool = True


class OutputNode(BaseModel):
    id: str
    type: Literal[NodeType.output]
    input: str
    name: str  # logical name for this output dataset


FlowNode = (
    SourceNode | JoinNode | FilterNode | AggregateNode |
    RenameNode | CalculateNode | SortNode | UnionNode | OutputNode
)


class FlowEdge(BaseModel):
    from_node: str = Field(alias="from")
    to_node: str = Field(alias="to")

    model_config = {"populate_by_name": True}


class TransformationPlan(BaseModel):
    plan_id: str
    name: str
    connection_id: str
    sql: str                          # the validated SQL this plan was derived from
    nodes: list[Any]                  # list of FlowNode (Any for Pydantic discriminated union compat)
    edges: list[FlowEdge]
    source_tables: list[str]
    output_columns: list[str] = Field(default_factory=list)
