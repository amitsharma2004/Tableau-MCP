# CLAUDE.md

## Project Overview

Build a database-driven Tableau Prep-style flow generation system. Users describe a data-preparation task in natural language. The system discovers the available database tables, retrieves relevant schemas, plans transformations, generates and validates SQL, and produces:

1. **Flow JSON** that conforms exactly to the existing frontend's contract.
2. **A Tableau Hyper extract** generated from the validated execution logic.

The project will use **Python**, **LangChain** for the SQL-agent workflow, and the **Python MCP SDK** to expose tools to Claude Desktop. Claude models (such as Sonnet or Opus) provide reasoning and generation. Python code must enforce deterministic validation and execution rules.

The guiding principle is to follow the LangChain SQL-agent tutorial's tool-driven workflow and extend it only where this project requires flow planning, flow JSON generation, and Hyper output.

## Current Decisions

- Backend language: Python.
- LLM workflow: LangChain SQL-agent pattern using `langchain-anthropic` (`ChatAnthropic`).
- MCP server: Python `mcp` SDK (`FastMCP`), running as a **stdio server** for Claude Desktop.
- Initial database support: SQLite, MySQL, PostgreSQL.
- Extensibility: a connector registry and shared database connector interface so new database types can be added without rewriting the agent workflow.
- Metadata: initially provide a JSON file describing tables, columns, data types, relationships, and business definitions.
- Outputs: our own Flow JSON schema (to be aligned with the frontend at the end) and a Tableau Hyper extract.
- Frontend: Flow JSON schema is defined by us now. Do not treat any contract as fixed until the frontend alignment step.
- Model choice: Claude (Sonnet/Opus) via the Anthropic API, invoked through LangChain. No automatic model routing.
- SQL checker: use `sqlglot` for AST-level parsing and dialect validation — not an LLM-based checker.
- Platform: Linux x86 — `tableauhyperapi` is compatible.
- Entry point: Claude Desktop invokes MCP tools over stdio; no separate HTTP server needed initially.

## Required Agent Workflow

Follow this workflow unless the user explicitly changes it:

1. Receive the user's natural-language request.
2. Call `sql_db_list_tables` to discover tables available in the selected connection.
3. Call `sql_db_schema` for relevant, existing tables.
4. Use the LLM to select relevant tables, interpret the request, plan transformations, and generate SQL.
5. Always call `sql_db_query_checker` before calling `sql_db_query`.
6. Execute the checked SQL using `sql_db_query`.
7. If SQL execution fails, inspect the error, retrieve the correct schema if needed, rewrite the query, check it again, and retry within a bounded retry limit.
8. Validate the transformation plan deterministically, including table/column references, joins, lineage, graph structure, and supported operations.
9. Generate Flow JSON from the validated plan using the existing frontend contract.
10. Generate the Hyper extract from the same validated plan/execution logic.
11. Return clear status and error information. Never claim success unless the corresponding operation actually succeeded.

Flow JSON and Hyper output must be derived from the same validated plan and consistent execution logic. Do not generate them as unrelated, independent LLM outputs.

## MCP Tools

Expose narrowly scoped tools to Claude Desktop through the MCP server. Keep tool names and schemas stable where possible.

### Database discovery and execution

- `list_connections`
  - Lists configured connection IDs and safe metadata such as database type and display name.
  - Never returns passwords, connection strings containing secrets, or raw credentials.

- `get_connection_details`
  - Returns safe configuration details for a selected connection. Do not expose secrets.

- `test_connection`
  - Checks whether the selected connection is reachable and authenticated.

- `sql_db_list_tables`
  - Input: selected `connection_id`.
  - Output: table names available to that connection.

- `sql_db_schema`
  - Input: selected `connection_id` and a list of table names.
  - Output: schemas including column names and data types; include sample rows only when enabled and safe.
  - Verify table names against actual database metadata before introspection.

- `sql_db_query_checker`
  - Input: selected connection and SQL query.
  - Checks syntax/dialect compatibility, table and column references where possible, and safety constraints.
  - This is not a guarantee of semantic correctness.

- `sql_db_query`
  - Input: selected connection and SQL query.
  - Executes only after query checking and policy enforcement.
  - Returns structured results or a sanitized error.

### Flow generation

- `validate_table_selection`
  - Checks that proposed tables exist and that their schemas support the requested task.

- `validate_flow_plan`
  - Validates the proposed transformation graph, table and column references, join paths, aggregation rules, and supported operations.

- `generate_flow_json`
  - Serializes a validated plan into the exact existing frontend JSON contract.

- `generate_hyper_extract`
  - Produces a Hyper extract from the validated execution logic and reports its real status and output location.

Do not create dummy implementations that report success without doing the work. If a tool is not implemented, return an explicit, structured `not_implemented` or equivalent error.

## Database Connector Architecture

Use a common interface and a registry. The agent and MCP tools should depend on the interface rather than directly on a specific database implementation.

The interface should cover at least:

- `test_connection()`
- `list_tables()`
- `get_schema(tables)`
- `check_query(sql)`
- `execute_query(sql)`
- `close()`

Initial implementations:

- SQLite connector
- MySQL connector
- PostgreSQL connector

Prefer SQLAlchemy for common connection management and SQL execution where appropriate, with database-specific drivers and dialect-aware behavior. Keep dialect-specific schema inspection and query validation behind the connector interface.

To add a new database, developers should be able to implement/register a connector without rewriting the LangChain workflow or MCP tool contracts.

Never assume SQL is portable between database engines. Validate SQL using the selected connection's dialect.

## Metadata JSON

Initially, table and business metadata will be supplied through a JSON file. Keep parsing and validation of this file in a dedicated module.

Where available, metadata should describe:

- Metadata version.
- Table names and descriptions.
- Column names, data types, and descriptions.
- Primary and foreign keys.
- Relationships and join cardinality.
- Business aliases and synonyms.
- Business metric definitions and formulas.
- Aggregation rules and known caveats.
- Date/time semantics.
- Optional examples of valid transformations.

Treat metadata as context, not proof that a table or column exists. Verify actual table/column existence against the selected database before execution. Do not invent missing schema fields. Report ambiguity rather than silently guessing.

Do not put credentials or secrets in the metadata JSON.

## LangChain Design

Follow the LangChain SQL-agent tutorial's core pattern:

- Discover tables.
- Retrieve schemas.
- Generate SQL.
- Check SQL before execution.
- Execute SQL.
- Repair failures using database error feedback, with a bounded retry count.

Keep the LLM responsible for interpreting natural language and proposing a plan/query. Keep deterministic application code responsible for validation, authorization, query execution, graph consistency, and output serialization.

Do not build a multi-agent system unless the project later demonstrates a concrete need. Prefer a simple, testable tool-driven workflow.

The SQL checker must always run before query execution. If an execution error identifies an unknown column or table, use schema introspection to obtain the correct fields before attempting a repair. Do not retry forever; make the retry limit configurable and return a useful error when exhausted.

## Transformation Plan and Flow JSON

Represent a transformation plan internally with a typed schema (for example, Pydantic models). The plan should explicitly identify:

- Source connection and source tables.
- Nodes and stable node IDs.
- Node operation/type.
- Node inputs and connections.
- Operation configuration.
- Referenced columns.
- Join conditions and join type.
- Filters, calculations, aggregations, renames, unions, sorting, and outputs where supported.

Only support operations that the compiler, validator, and frontend can actually represent. Do not invent frontend node types or configuration keys.

The plan validator should check:

- Every referenced table and column exists.
- All node IDs are unique.
- All referenced upstream nodes exist.
- The graph is acyclic.
- Join keys and join paths are valid and unambiguous.
- Aggregation and grouping rules are coherent.
- Expressions and operations are supported.
- The plan preserves the user's requested intent.
- The SQL and flow plan are consistent.

Flow JSON must be serialized using the existing frontend's exact contract. Before implementing serialization, inspect the frontend source and find representative valid flow JSON. Do not guess the schema. Add contract tests using known-good examples.

## SQL Execution and Security

Treat generated SQL as untrusted.

- Use read-only database credentials for planning and query execution wherever possible.
- Permit only the SQL operations required by the product; default to read-only `SELECT` queries.
- Reject destructive statements and unauthorized multi-statement queries.
- Use parameter binding for user-supplied values.
- Validate identifiers against database metadata or an allowlist; SQL parameters generally cannot safely substitute table/column identifiers.
- Enforce query timeouts, row limits, and reasonable resource limits.
- Avoid logging credentials or sensitive row data.
- Sanitize database errors before returning them to the LLM or user.
- Do not expose secrets in MCP tool outputs.
- Ensure the requested `connection_id` is authorized for the current operation.
- Do not execute a query merely because the LLM generated it or the checker accepted it.

If a requested operation cannot be performed safely, fail explicitly and explain why.

## Hyper Extract Generation

Use the appropriate Tableau Hyper API workflow for `.hyper` generation. Keep Hyper creation in a dedicated module.

- Generate the extract from the validated query/plan so it matches the Flow JSON.
- Handle schema and data type mapping explicitly.
- Report creation failures and cleanup temporary resources.
- Do not claim a Hyper file exists until creation has been confirmed.
- Keep output paths configurable and avoid overwriting unrelated files without explicit policy.

## Suggested Project Structure

Adapt this to the repository's existing layout rather than reorganizing everything without need.

```text
project/
├── CLAUDE.md
├── pyproject.toml              # or requirements.txt
├── .env.example
├── config/
│   └── database_metadata.json
├── src/
│   ├── app.py                  # application entry point, if needed
│   ├── mcp_server.py           # MCP tool registration
│   ├── agent/
│   │   ├── workflow.py         # LangChain orchestration
│   │   ├── prompts.py
│   │   └── state.py
│   ├── connectors/
│   │   ├── base.py             # shared interface
│   │   ├── registry.py
│   │   ├── sqlite.py
│   │   ├── mysql.py
│   │   └── postgresql.py
│   ├── tools/
│   │   ├── database_tools.py
│   │   ├── validation_tools.py
│   │   └── output_tools.py
│   ├── schemas/
│   │   ├── plan.py
│   │   └── metadata.py
│   ├── validation/
│   │   ├── sql.py
│   │   ├── lineage.py
│   │   └── flow_plan.py
│   └── outputs/
│       ├── flow_json.py
│       └── hyper_extract.py
└── tests/
    ├── connectors/
    ├── tools/
    ├── validation/
    ├── agent/
    └── contract/
```

Do not create all these files blindly. Inspect the repository first and follow its existing conventions.

## Configuration and Dependencies

Use a virtual environment. Check the project's Python version and dependency manager before changing dependencies.

MCP SDK installation:

```bash
pip install "mcp[cli]"
```

The plain `pip install mcp` package is also valid if CLI extras are not required. Confirm SDK/API versions from the installed package and official documentation instead of relying on outdated examples.

Add only dependencies actually needed by the implementation. Likely candidates include LangChain's relevant integration packages, SQLAlchemy, database drivers, Pydantic, and `tableauhyperapi`. Do not assume a specific LLM integration package is already installed.

Provide `.env.example` with placeholder variable names only. Never commit actual credentials.

## Development Order

Implement in small, testable vertical slices:

1. Inspect the existing repository and frontend JSON contract.
2. Define and validate the metadata JSON format.
3. Implement the connector interface and registry.
4. Implement and test SQLite, MySQL, and PostgreSQL connectors.
5. Expose connection and schema tools through MCP.
6. Implement SQL checker, safe execution, and bounded repair.
7. Define typed transformation-plan models and deterministic validation.
8. Integrate the LangChain SQL-agent workflow.
9. Serialize validated plans to the existing Flow JSON contract.
10. Generate a Hyper extract from the same validated plan.
11. Add end-to-end tests and verify Claude Desktop MCP configuration.

Do not skip the frontend contract inspection. Flow JSON compatibility is a core requirement.

## Testing Requirements

Add tests for:

- Connector registration and unsupported database types.
- Connection failures and invalid connection IDs.
- Missing tables and columns.
- SQL checker being called before query execution.
- SQL errors and bounded repair attempts.
- SQL injection and destructive statement rejection.
- Database dialect differences.
- Ambiguous table selection and join paths.
- Invalid/cyclic transformation graphs.
- Invalid aggregation/grouping logic.
- Flow JSON contract compatibility.
- Hyper extract success and failure handling.
- End-to-end request-to-output behavior.

Use mocks for LLMs and external databases where appropriate. Add integration tests for each supported database when test instances are available. Tests must not require production credentials.

## Instructions for Claude Code

When working in this repository:

1. Inspect the current files, dependency configuration, and frontend contract before proposing broad changes.
2. Summarize the implementation plan briefly before making large structural changes.
3. Prefer minimal, incremental changes that preserve existing behavior.
4. Do not invent schema details, frontend fields, tool APIs, or environment variables. Search the repository and verify assumptions.
5. Keep secrets out of source code, prompts, logs, test fixtures, and tool results.
6. Use typed models and explicit error handling at tool boundaries.
7. Add or update tests with every meaningful behavior change.
8. Run relevant tests and report which commands passed or failed. Never claim tests passed if they were not run.
9. Keep SQL execution, plan validation, and Flow JSON serialization deterministic wherever possible.
10. Ask for clarification only when a missing decision blocks safe or correct implementation; otherwise make a small, documented, reversible choice.
11. Do not change the frontend JSON contract unless explicitly requested.
12. Do not implement speculative features, automatic model routing, or extra agents without a demonstrated need.

## Definition of Done

A feature is complete only when:

- It follows the agreed workflow.
- Inputs and outputs are validated.
- Errors are explicit and recoverable where possible.
- Security constraints are enforced in code, not only in prompts.
- Tests cover the behavior.
- Flow JSON matches the existing frontend contract.
- Hyper output, when requested, is generated from the same validated plan and execution logic.
- Documentation accurately describes what is implemented and what remains unsupported.
