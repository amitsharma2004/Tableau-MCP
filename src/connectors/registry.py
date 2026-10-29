import json
import os
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import DatabaseConnector


_CONNECTIONS_CONFIG: dict = {}
_CONNECTOR_FACTORIES: dict = {}


def _load_config() -> dict:
    global _CONNECTIONS_CONFIG
    if _CONNECTIONS_CONFIG:
        return _CONNECTIONS_CONFIG
    path = Path(os.getenv("CONNECTIONS_CONFIG", "config/connections.json"))
    if not path.exists():
        raise FileNotFoundError(f"Connections config not found: {path}")
    with path.open() as f:
        _CONNECTIONS_CONFIG = json.load(f).get("connections", {})
    return _CONNECTIONS_CONFIG


def _register_defaults() -> None:
    if _CONNECTOR_FACTORIES:
        return
    from .sqlite import SQLiteConnector
    from .mysql import MySQLConnector
    from .postgresql import PostgreSQLConnector

    _CONNECTOR_FACTORIES["sqlite"] = SQLiteConnector
    _CONNECTOR_FACTORIES["mysql"] = MySQLConnector
    _CONNECTOR_FACTORIES["postgresql"] = PostgreSQLConnector


def list_connections() -> list[dict]:
    """Return safe metadata for all configured connections (no secrets)."""
    cfg = _load_config()
    return [
        {"connection_id": cid, "type": v["type"], "display_name": v.get("display_name", cid)}
        for cid, v in cfg.items()
    ]


def get_connection_details(connection_id: str) -> dict:
    """Return safe config for a connection — never exposes passwords."""
    cfg = _load_config()
    if connection_id not in cfg:
        raise KeyError(f"Unknown connection_id: {connection_id!r}")
    entry = cfg[connection_id]
    safe = {k: v for k, v in entry.items() if k not in ("password", "secret", "url")}
    safe["connection_id"] = connection_id
    return safe


def get_connector(connection_id: str) -> "DatabaseConnector":
    """Instantiate and return a connector for the given connection_id."""
    _register_defaults()
    cfg = _load_config()
    if connection_id not in cfg:
        raise KeyError(f"Unknown connection_id: {connection_id!r}")
    entry = cfg[connection_id]
    db_type = entry["type"]
    if db_type not in _CONNECTOR_FACTORIES:
        raise ValueError(f"Unsupported database type: {db_type!r}")
    return _CONNECTOR_FACTORIES[db_type](entry)
