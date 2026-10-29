"""Pydantic models for database_metadata.json."""
import json
import os
from pathlib import Path

from pydantic import BaseModel


class ColumnMeta(BaseModel):
    type: str
    description: str = ""


class RelationshipKey(BaseModel):
    local: str
    foreign: str


class Relationship(BaseModel):
    join_type: str = "LEFT"
    cardinality: str = ""
    keys: list[RelationshipKey]
    note: str = ""


class TableMeta(BaseModel):
    description: str = ""
    columns: dict[str, ColumnMeta] = {}
    primary_key: str = ""
    business_keys: list[str] = []
    relationships: dict[str, Relationship] = {}
    caveats: list[str] = []


class MetricMeta(BaseModel):
    description: str = ""
    formula: str = ""
    base_table: str = ""
    base_tables: list[str] = []
    caveat: str = ""


class DatabaseMetadata(BaseModel):
    version: str = "1.0"
    connection_id: str = ""
    description: str = ""
    tables: dict[str, TableMeta] = {}
    metrics: dict[str, MetricMeta] = {}


_CACHE: DatabaseMetadata | None = None


def load_metadata() -> DatabaseMetadata:
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    path = Path(os.getenv("METADATA_CONFIG", "config/database_metadata.json"))
    if not path.exists():
        _CACHE = DatabaseMetadata()
        return _CACHE
    with path.open() as f:
        data = json.load(f)
    _CACHE = DatabaseMetadata.model_validate(data)
    return _CACHE
