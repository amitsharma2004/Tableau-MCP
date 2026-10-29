"""Serialize a validated plan dict into Flow JSON."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone


def generate(plan: dict, name: str | None = None) -> dict:
    """
    Wrap a validated plan dict into the canonical Flow JSON envelope.

    Flow JSON schema (v1):
    {
      "schema_version": "1.0",
      "flow_id": "<uuid>",
      "name": "<str>",
      "connection_id": "<str>",
      "created_at": "<iso8601>",
      "sql": "<validated sql>",
      "nodes": [...],   # as provided by LLM / validator
      "edges": [...]    # as provided by LLM / validator
    }
    """
    flow = {
        "schema_version": "1.0",
        "flow_id": plan.get("flow_id") or str(uuid.uuid4()),
        "name": name or plan.get("name", "Untitled Flow"),
        "connection_id": plan.get("connection_id", ""),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "sql": plan.get("sql", ""),
        "nodes": plan.get("nodes", []),
        "edges": plan.get("edges", []),
    }
    return flow


def to_json_string(plan: dict, name: str | None = None, indent: int = 2) -> str:
    return json.dumps(generate(plan, name), indent=indent, ensure_ascii=False)
