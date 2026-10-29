"""SQLite store — schema init and connection factory."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def _db_path() -> Path:
    env = os.getenv("APP_DB_PATH")
    if env:
        return Path(env)
    here = Path(__file__).parent.parent.parent
    return here / "data" / "app.db"


def get_conn() -> sqlite3.Connection:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_conn()
    with conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS flows (
            flow_id             TEXT PRIMARY KEY,
            schema_version      TEXT NOT NULL DEFAULT '1.0',
            name                TEXT NOT NULL,
            connection_id       TEXT NOT NULL,
            sql                 TEXT NOT NULL,
            nodes_json          TEXT NOT NULL,
            edges_json          TEXT NOT NULL,
            source_tables_json  TEXT NOT NULL DEFAULT '[]',
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
            id              TEXT PRIMARY KEY,
            flow_id         TEXT NOT NULL REFERENCES flows(flow_id),
            version_number  INTEGER NOT NULL,
            nodes_json      TEXT NOT NULL,
            edges_json      TEXT NOT NULL,
            sql             TEXT NOT NULL,
            change_summary  TEXT,
            created_at      TEXT NOT NULL,
            created_by      TEXT NOT NULL DEFAULT 'user'
        );

        CREATE TABLE IF NOT EXISTS query_runs (
            id          TEXT PRIMARY KEY,
            flow_id     TEXT NOT NULL REFERENCES flows(flow_id),
            sql         TEXT NOT NULL,
            rows_json   TEXT NOT NULL DEFAULT '[]',
            row_count   INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'ok',
            error       TEXT,
            executed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS hyper_extracts (
            id          TEXT PRIMARY KEY,
            flow_id     TEXT NOT NULL REFERENCES flows(flow_id),
            file_path   TEXT NOT NULL,
            row_count   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL
        );
        """)
    conn.close()
