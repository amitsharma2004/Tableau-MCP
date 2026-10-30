"""Apache Calcite integration via JPype — flow JSON → optimized SQL."""
from .translator import compile_flow

__all__ = ["compile_flow"]
