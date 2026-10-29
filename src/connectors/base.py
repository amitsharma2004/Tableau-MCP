from abc import ABC, abstractmethod
from typing import Any


class DatabaseConnector(ABC):
    """Shared interface for all database connectors."""

    @abstractmethod
    def test_connection(self) -> bool: ...

    @abstractmethod
    def list_tables(self) -> list[str]: ...

    @abstractmethod
    def get_schema(self, tables: list[str]) -> str:
        """Return DDL + 3 sample rows for each requested table."""
        ...

    @abstractmethod
    def check_query(self, sql: str) -> tuple[bool, str]:
        """
        Validate SQL syntax and safety.
        Returns (ok, message_or_corrected_sql).
        """
        ...

    @abstractmethod
    def execute_query(self, sql: str) -> list[dict[str, Any]]: ...

    @abstractmethod
    def close(self) -> None: ...

    # Context-manager support
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
