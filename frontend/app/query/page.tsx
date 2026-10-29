"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { useActor } from "@/lib/actor-context";
import type { Connection } from "@/lib/types";
import { Send, History, ChevronDown, ChevronUp, Trash2, Code2, Clock, ExternalLink } from "lucide-react";

interface QueryResult {
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  error?: string | null;
}

interface HistoryEntry {
  id: string;
  query: string;
  connectionName: string;
  connectionId: string;
  sql: string;
  rowCount: number;
  timestamp: string;
  error?: string | null;
}

const HISTORY_KEY = "nlquery_history";

function loadHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 50)));
  } catch {}
}

export default function QueryPage() {
  const { actorEmail } = useActor();
  const router = useRouter();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [query, setQuery] = useState("");
  const [lastSubmittedQuery, setLastSubmittedQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [openingFlow, setOpeningFlow] = useState(false);
  const [openFlowError, setOpenFlowError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setHistory(loadHistory());
    api
      .listConnections(actorEmail)
      .then((conns) => {
        setConnections(conns);
        if (conns.length > 0) setSelectedConnectionId(conns[0].id);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Failed to load connections"));
  }, [actorEmail]);

  const selectedConnection = connections.find((c) => c.id === selectedConnectionId);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim() || !selectedConnectionId || loading) return;

    setLoading(true);
    setResult(null);
    setShowSql(false);
    setLastSubmittedQuery(query.trim());

    try {
      const res = await api.nlQuery(actorEmail, selectedConnectionId, query.trim());
      setResult(res);

      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        query: query.trim(),
        connectionName: selectedConnection?.name ?? selectedConnectionId,
        connectionId: selectedConnectionId,
        sql: res.sql,
        rowCount: res.row_count,
        timestamp: new Date().toISOString(),
        error: res.error,
      };
      const updated = [entry, ...history];
      setHistory(updated);
      saveHistory(updated);
    } catch (err) {
      const msg = err instanceof ApiError
        ? `Error ${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      setResult({ sql: "", columns: [], rows: [], row_count: 0, error: msg });
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function openInFlowStudio() {
    if (!selectedConnectionId || !lastSubmittedQuery) return;
    setOpeningFlow(true);
    setOpenFlowError(null);
    try {
      const name = lastSubmittedQuery.slice(0, 60) + (lastSubmittedQuery.length > 60 ? "..." : "");
      const flow = await api.createFlow(actorEmail, {
        name,
        nl_request: lastSubmittedQuery,
        source_connection_id: selectedConnectionId,
      });
      // Generate plan so canvas isn't blank when flow studio opens
      await api.generatePlan(actorEmail, flow.id);
      router.push(`/flows/new?flowId=${flow.id}`);
    } catch (err) {
      const msg = err instanceof ApiError
        ? `Error ${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
      setOpenFlowError(msg);
      setOpeningFlow(false);
    }
  }

  function loadFromHistory(entry: HistoryEntry) {
    setSelectedConnectionId(entry.connectionId);
    setQuery(entry.query);
    setShowHistory(false);
    textareaRef.current?.focus();
  }

  function clearHistory() {
    setHistory([]);
    saveHistory([]);
  }

  return (
    <div className="flex h-[calc(100vh-52px)]">
      {/* History sidebar */}
      <div
        className={`flex-shrink-0 border-r border-slate-200 bg-slate-50 transition-all duration-200 overflow-hidden ${
          showHistory ? "w-72" : "w-0"
        }`}
      >
        <div className="w-72 h-full flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <span className="text-sm font-medium text-slate-700">Query History</span>
            {history.length > 0 && (
              <button
                onClick={clearHistory}
                className="text-slate-400 hover:text-red-500 transition-colors"
                title="Clear history"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {history.length === 0 ? (
              <p className="text-xs text-slate-400 px-4 py-6 text-center">No history yet</p>
            ) : (
              history.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => loadFromHistory(entry)}
                  className="w-full text-left px-4 py-3 hover:bg-slate-100 border-b border-slate-100 transition-colors"
                >
                  <p className="text-xs font-medium text-slate-800 line-clamp-2">{entry.query}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-slate-400">{entry.connectionName}</span>
                    <span className="text-xs text-slate-300">·</span>
                    <span className={`text-xs ${entry.error ? "text-red-400" : "text-green-600"}`}>
                      {entry.error ? "error" : `${entry.rowCount} rows`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Clock size={10} className="text-slate-300" />
                    <span className="text-xs text-slate-300">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-200 bg-white">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className={`flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded transition-colors ${
              showHistory ? "bg-blue-50 text-blue-600" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <History size={15} />
            <span>History</span>
            {history.length > 0 && (
              <span className="bg-slate-200 text-slate-600 text-xs rounded-full px-1.5 py-0 leading-4">
                {history.length}
              </span>
            )}
          </button>

          <div className="flex items-center gap-2 ml-auto">
            <label className="text-xs text-slate-500">Connection</label>
            <select
              value={selectedConnectionId}
              onChange={(e) => setSelectedConnectionId(e.target.value)}
              className="border border-slate-200 rounded px-2 py-1 text-sm text-slate-700 bg-white"
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
          </div>
        </div>

        {loadError && (
          <div className="mx-4 mt-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {loadError}
          </div>
        )}

        {/* Results area */}
        <div className="flex-1 overflow-auto px-4 py-4">
          {!result && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="text-4xl mb-3">🔍</div>
              <p className="text-slate-500 text-sm">Type a natural language query below and press Enter</p>
              <p className="text-slate-400 text-xs mt-1">
                e.g. "How many articles are completed per journal?"
              </p>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-slate-500">Running query via Qwen...</p>
            </div>
          )}

          {result && !loading && (
            <div className="space-y-3">
              {result.error ? (
                <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                  <p className="text-sm font-medium text-red-700">Error</p>
                  <p className="text-sm text-red-600 mt-1 whitespace-pre-wrap">{result.error}</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-slate-500">
                      {result.row_count} {result.row_count === 1 ? "row" : "rows"} returned
                    </p>
                    <div className="flex items-center gap-3">
                      {result.sql && (
                        <button
                          onClick={() => setShowSql((v) => !v)}
                          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
                        >
                          <Code2 size={13} />
                          {showSql ? "Hide SQL" : "Show SQL"}
                          {showSql ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      )}
                      <div className="flex flex-col items-end gap-1">
                        <button
                          onClick={openInFlowStudio}
                          disabled={openingFlow}
                          className="flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded transition-colors"
                        >
                          <ExternalLink size={12} />
                          {openingFlow ? "Generating plan..." : "Open in Flow Studio"}
                        </button>
                        {openFlowError && (
                          <p className="text-xs text-red-600 max-w-xs text-right">{openFlowError}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {showSql && result.sql && (
                    <pre className="bg-slate-900 text-slate-100 rounded-lg px-4 py-3 text-xs overflow-x-auto whitespace-pre-wrap">
                      {result.sql}
                    </pre>
                  )}

                  {result.rows.length > 0 ? (
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="min-w-full divide-y divide-slate-200 text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            {result.columns.map((col) => (
                              <th
                                key={col}
                                className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide whitespace-nowrap"
                              >
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {result.rows.map((row, i) => (
                            <tr key={i} className="hover:bg-slate-50">
                              {result.columns.map((col) => (
                                <td key={col} className="px-3 py-2 text-slate-700 whitespace-nowrap max-w-xs truncate">
                                  {row[col] === null || row[col] === undefined ? (
                                    <span className="text-slate-300 italic">null</span>
                                  ) : (
                                    String(row[col])
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 text-center py-8">No rows returned</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Query input */}
        <div className="border-t border-slate-200 bg-white px-4 py-3">
          <form onSubmit={handleSubmit} className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question about your data... (Enter to submit, Shift+Enter for new line)"
              rows={2}
              className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !query.trim() || !selectedConnectionId}
              className="flex-shrink-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 transition-colors flex items-center gap-2"
            >
              <Send size={15} />
              <span className="text-sm">Run</span>
            </button>
          </form>
          <p className="text-xs text-slate-400 mt-1.5">
            Powered by Qwen 2.5 Coder 7B · Shift+Enter for new line
          </p>
        </div>
      </div>
    </div>
  );
}
