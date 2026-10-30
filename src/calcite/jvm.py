"""JVM lifecycle — start once, keep alive for the process."""
from __future__ import annotations

import glob
import os
from pathlib import Path

_STARTED = False
_JAR_DIR = Path(__file__).parent / "jars"


def ensure_jvm() -> None:
    """Start the JVM with the Calcite classpath (idempotent)."""
    global _STARTED
    try:
        import jpype
    except ImportError as exc:
        raise RuntimeError("JPype is not installed. Run: pip install JPype1") from exc

    if _STARTED or jpype.isJVMStarted():
        _STARTED = True
        return

    jars = glob.glob(str(_JAR_DIR / "*.jar"))
    if not jars:
        raise RuntimeError(
            f"No Calcite JARs found in {_JAR_DIR}.\n"
            "Run:  bash scripts/download_calcite_jars.sh"
        )

    jpype.startJVM(classpath=jars, convertStrings=True)
    import jpype.imports  # noqa: F401 — enables `from org.apache...` style imports
    _STARTED = True
