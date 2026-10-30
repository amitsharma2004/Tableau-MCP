#!/usr/bin/env bash
# Download Apache Calcite JARs (and all transitive dependencies) into
# src/calcite/jars/ using Maven.  Run once before starting the backend.
#
# Requirements: Java + Maven must be on PATH.
#   sudo apt install default-jdk maven   # Debian/Ubuntu
#   brew install openjdk maven           # macOS

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR_DIR="$SCRIPT_DIR/../src/calcite/jars"

mkdir -p "$JAR_DIR"

echo "→ Downloading Calcite JARs into $JAR_DIR ..."

mvn -f "$SCRIPT_DIR/../src/calcite/pom.xml" \
    dependency:copy-dependencies \
    -DoutputDirectory="$JAR_DIR" \
    -DincludeScope=runtime \
    -q

echo "✓ Done. $(ls "$JAR_DIR"/*.jar | wc -l) JARs downloaded."
echo "  Verify JPype is installed:  pip install JPype1"
