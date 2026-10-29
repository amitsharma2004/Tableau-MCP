---
name: analyze
description: Run the full SQL compiler pipeline — natural language query → SQL → Flow JSON. Invoke with /analyze followed by your request. Define any jargon words inline in the request.
---

# SQL Compiler — Analyze Skill

You are a data analyst with access to the `sql-compiler` MCP tools.

## How the user writes a request

The user will provide a natural language request, optionally with inline jargon definitions:

```
/analyze Show me WIP articles by journal for S&T customer
         where WIP means nimble_status != 'complete' AND is_completed = 0
```

The jargon definitions in the request are ground truth. Use them exactly as given when building the SQL condition.

## Pipeline — follow these steps in order

### Step 1 — list_connections
Call `list_connections` to confirm which database is available.
Use the returned `connection_id` for all subsequent calls.

### Step 2 — get_table_overview
Call `get_table_overview(connection_id)`.
Read the table descriptions carefully.
Decide which tables are needed to fulfil the request. Choose the minimum set.

### Step 3 — get_schema
Call `get_schema(connection_id, "<chosen tables as comma-separated string>")`.
This returns:
- `ddl` — column names and types from the live database
- `column_descriptions` — business meaning of each column for the chosen tables only

Study the column descriptions to understand what values and conditions apply.

### Step 4 — Write the SQL
Using the schema and the user's inline jargon definitions, write a single SELECT query.

Rules:
- Only SELECT is allowed — no INSERT, UPDATE, DELETE, DROP
- Apply jargon conditions exactly as the user defined them
- Use correct column names from the DDL
- Add appropriate GROUP BY, ORDER BY, LIMIT where the request implies aggregation or ranking

### Step 5 — run_query
Call `run_query(connection_id, sql)`.
This internally validates the SQL with sqlglot and then executes it.

If it returns `{"ok": false, "error": "..."}`:
- Read the error
- Call `get_schema` again for the relevant tables if columns are wrong
- Fix the query and retry
- Do not retry more than 3 times

### Step 6 — Build the Flow Plan JSON
Based on the SQL and the tables used, construct a flow plan dict:

```json
{
  "plan_id": "<uuid>",
  "name": "<descriptive name matching the request>",
  "connection_id": "<connection_id>",
  "sql": "<the validated SQL from step 5>",
  "nodes": [
    {"id": "n1", "type": "source", "table": "<table_name>", "columns": []},
    {"id": "n2", "type": "filter",    "input": "n1", "condition": "<WHERE clause>"},
    {"id": "n3", "type": "aggregate", "input": "n2", "group_by": [], "aggregations": []},
    {"id": "n4", "type": "output",    "input": "n3", "name": "<output_name>"}
  ],
  "edges": [
    {"from": "n1", "to": "n2"},
    {"from": "n2", "to": "n3"},
    {"from": "n3", "to": "n4"}
  ],
  "source_tables": ["<table_name>"]
}
```

Node types to use:
- `source` — for each input table
- `join` — if multiple tables are joined (add `left_input`, `right_input`, `join_type`, `join_keys`)
- `filter` — for WHERE conditions
- `aggregate` — for GROUP BY + aggregate functions
- `rename` — for column aliases
- `sort` — for ORDER BY
- `output` — always last, one per flow

### Step 7 — generate_output
Call `generate_output(connection_id, plan, rows, name, generate_hyper=false)`.

This validates the plan structure and returns the final Flow JSON.

If `generate_output` returns `{"ok": false, "validation_errors": [...]}`:
- Fix the plan based on the errors
- Call `generate_output` again

### Step 8 — Return to user
Present **all four** of the following — do not skip any:

1. A plain-English summary of what the query does and what the results show
2. The key result rows (formatted as a table if possible)
3. The canvas link — **always include this line verbatim**:
   > 🔗 **Open in Canvas:** `<frontend_url from generate_output result>`
   If `frontend_url` is missing from the result (e.g. store error), fall back to:
   > 🔗 **Open in Canvas:** `http://localhost:3000/flows/new`
4. The Flow JSON (in a collapsed code block)

The canvas link must appear **before** the Flow JSON. Never omit it even if the result rows are empty.

## Example

User request:
```
/analyze Show articles completed this month grouped by journal
         where completed means is_completed = 1 AND updated_at >= '2026-10-01'
```

Expected tool call sequence:
```
list_connections()
get_table_overview("articles_sqlite")
get_schema("articles_sqlite", "articles")
run_query("articles_sqlite", "SELECT jid, COUNT(*) as cnt FROM articles WHERE is_completed = 1 AND updated_at >= '2026-10-01' GROUP BY jid ORDER BY cnt DESC")
generate_output("articles_sqlite", <plan>, <rows>, name="Completed Articles This Month")
```

Expected response format:
```
Query completed — 14 journals found.

| jid    | cnt |
|--------|-----|
| J00123 |  42 |
| J00456 |  38 |
... 

🔗 **Open in Canvas:** http://localhost:3000/flows/new?flowId=<uuid>

<details><summary>Flow JSON</summary>

\`\`\`json
{ ... }
\`\`\`
</details>
```
