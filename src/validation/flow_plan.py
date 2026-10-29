"""Deterministic structural validator for LLM-generated flow plans."""
from __future__ import annotations

from collections import deque
from typing import Any


def _get(node: Any, key: str):
    return node.get(key) if isinstance(node, dict) else getattr(node, key, None)


def _node_inputs(node: Any) -> list[str]:
    inputs: list[str] = []
    for key in ("input", "left_input", "right_input", "inputs"):
        val = _get(node, key)
        if val:
            inputs.extend(val if isinstance(val, list) else [val])
    return inputs


def validate_plan(plan: dict) -> list[str]:
    """
    Structural validation of a flow plan dict.
    Returns list of error strings — empty = valid.

    Checks:
      1. Unique node IDs
      2. All referenced upstream nodes exist
      3. All edge endpoints exist
      4. Graph is acyclic (Kahn's algorithm)
      5. At least one output node present
    """
    errors: list[str] = []
    nodes: list[Any] = plan.get("nodes", [])
    edges: list[Any] = plan.get("edges", [])

    # 1. Unique IDs
    ids: set[str] = set()
    for n in nodes:
        nid = _get(n, "id")
        if nid in ids:
            errors.append(f"Duplicate node id: {nid!r}")
        ids.add(nid)

    # 2. Upstream references
    for n in nodes:
        for inp in _node_inputs(n):
            if inp not in ids:
                errors.append(f"Node {_get(n, 'id')!r} references unknown input {inp!r}")

    # 3. Edge endpoints
    for edge in edges:
        frm = edge.get("from") if isinstance(edge, dict) else None
        to = edge.get("to") if isinstance(edge, dict) else None
        if frm not in ids:
            errors.append(f"Edge 'from' references unknown node {frm!r}")
        if to not in ids:
            errors.append(f"Edge 'to' references unknown node {to!r}")

    # 4. Acyclicity
    if not errors:
        adj: dict[str, list[str]] = {nid: [] for nid in ids}
        in_deg: dict[str, int] = {nid: 0 for nid in ids}
        for edge in edges:
            frm = edge.get("from") if isinstance(edge, dict) else None
            to = edge.get("to") if isinstance(edge, dict) else None
            if frm in adj and to in adj:
                adj[frm].append(to)
                in_deg[to] += 1
        queue = deque(nid for nid, d in in_deg.items() if d == 0)
        visited = 0
        while queue:
            nid = queue.popleft()
            visited += 1
            for nb in adj[nid]:
                in_deg[nb] -= 1
                if in_deg[nb] == 0:
                    queue.append(nb)
        if visited != len(ids):
            errors.append("Transformation graph contains a cycle.")

    # 5. Output node
    if not any(_get(n, "type") == "output" for n in nodes):
        errors.append("Plan must have at least one output node.")

    return errors
