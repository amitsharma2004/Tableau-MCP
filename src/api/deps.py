"""Common FastAPI dependencies."""
from __future__ import annotations

from fastapi import Header


def get_actor(x_actor_email: str = Header(default="user")) -> str:
    return x_actor_email if "@" in x_actor_email else "user"
