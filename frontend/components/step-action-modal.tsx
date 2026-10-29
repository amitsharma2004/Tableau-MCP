"use client";

import React, { useState } from "react";
import {
  Tag, Filter, CopyX, Calculator, Link2, GitMerge, Code2, ArrowRightToLine,
  X, Check, Plus, Trash, ChevronRight,
} from "lucide-react";
import type { CleanOperation } from "@/lib/flow-sql";

export interface StepActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceAlias: string;
  columns: string[];
  onApplyStep: (step: any) => void;
  onTriggerJoin?: (sourceAlias: string) => void;
  onTriggerUnion?: (sourceAlias: string) => void;
}

type StepType = "clean" | "join" | "script" | "union" | "output";

const STEP_TYPES: {
  id: StepType; label: string; badge?: string; description: string; icon: React.ElementType; color: string;
}[] = [
  { id: "clean",  label: "Clean Step",  badge: "Required", description: "Rename, filter, deduplicate, or add calculated fields", icon: Tag,            color: "teal" },
  { id: "join",   label: "Join Step",   badge: "Required", description: "Combine two tables by matching columns",                  icon: Link2,          color: "purple" },
  { id: "script", label: "Script Step", badge: "Optional", description: "Attach a script note (SQL passes rows through)",          icon: Code2,          color: "slate" },
  { id: "union",  label: "Union Step",  description:       "Stack rows from multiple tables (UNION ALL)",                          icon: GitMerge,       color: "yellow" },
  { id: "output", label: "Output",      badge: "Required", description: "Mark the final output step for this flow",                icon: ArrowRightToLine, color: "emerald" },
];

const CLEAN_OPS: { id: string; label: string; desc: string }[] = [
  { id: "rename",        label: "(a) Rename",                  desc: "Rename column names" },
  { id: "filter_values", label: "(b) Filter Values",           desc: "Filter rows by conditions" },
  { id: "dedup",         label: "(c) Identify Duplicate Rows", desc: "Remove duplicate rows" },
  { id: "calculate",     label: "(d) Create Calculated Field", desc: "Add a custom SQL expression" },
];

export function StepActionModal({
  isOpen, onClose, sourceAlias, columns, onApplyStep, onTriggerJoin, onTriggerUnion,
}: StepActionModalProps) {
  const [stepType, setStepType] = useState<StepType | null>(null);
  const [operations, setOperations] = useState<CleanOperation[]>([]);
  const [addingOp, setAddingOp] = useState<string | null>(null);

  // Rename form
  const [renamePairs, setRenamePairs] = useState<{ oldCol: string; newCol: string }[]>([
    { oldCol: columns[0] || "", newCol: "" },
  ]);

  // Filter form
  const [filterConds, setFilterConds] = useState<{ column: string; operator: string; value: string }[]>([
    { column: columns[0] || "", operator: "=", value: "" },
  ]);
  const [filterLogic, setFilterLogic] = useState<"AND" | "OR">("AND");

  // Dedup form
  const [dedupCols, setDedupCols] = useState<string[]>([]);

  // Calculate form
  const [calcName, setCalcName] = useState("");
  const [calcExpr, setCalcExpr] = useState("");

  // Script form
  const [scriptContent, setScriptContent] = useState("");

  // Output alias
  const [outputAlias, setOutputAlias] = useState(`${sourceAlias}_cleaned`);

  React.useEffect(() => {
    if (!isOpen) {
      setStepType(null);
      setOperations([]);
      setAddingOp(null);
      setRenamePairs([{ oldCol: columns[0] || "", newCol: "" }]);
      setFilterConds([{ column: columns[0] || "", operator: "=", value: "" }]);
      setFilterLogic("AND");
      setDedupCols([]);
      setCalcName("");
      setCalcExpr("");
      setScriptContent("");
      setOutputAlias(`${sourceAlias}_cleaned`);
    }
  }, [isOpen, sourceAlias, columns]);

  if (!isOpen) return null;

  function handleSelectStep(type: StepType) {
    if (type === "join")  { onTriggerJoin?.(sourceAlias); onClose(); return; }
    if (type === "union") { onTriggerUnion?.(sourceAlias); onClose(); return; }
    setStepType(type);
    setOutputAlias(type === "output" ? "output" : type === "script" ? `${sourceAlias}_script` : `${sourceAlias}_cleaned`);
  }

  function commitOp() {
    if (!addingOp) return;
    if (addingOp === "rename") {
      const mapping: Record<string, string> = {};
      renamePairs.forEach((p) => { if (p.oldCol && p.newCol.trim()) mapping[p.oldCol] = p.newCol.trim(); });
      if (!Object.keys(mapping).length) return;
      setOperations((prev) => [...prev, { op: "rename", mapping }]);
      setRenamePairs([{ oldCol: columns[0] || "", newCol: "" }]);
    } else if (addingOp === "filter_values") {
      const valid = filterConds.filter((c) => c.column);
      if (!valid.length) return;
      setOperations((prev) => [...prev, {
        op: "filter_values",
        conditions: valid.map((c) => ({
          column: c.column, operator: c.operator,
          value: isNaN(Number(c.value)) || c.value === "" ? c.value : Number(c.value) as any,
        })),
        logic: filterLogic,
      }]);
      setFilterConds([{ column: columns[0] || "", operator: "=", value: "" }]);
    } else if (addingOp === "dedup") {
      setOperations((prev) => [...prev, { op: "dedup", columns: dedupCols.length ? dedupCols : null }]);
      setDedupCols([]);
    } else if (addingOp === "calculate") {
      if (!calcName.trim() || !calcExpr.trim()) return;
      setOperations((prev) => [...prev, { op: "calculate", name: calcName.trim(), expression: calcExpr.trim() }]);
      setCalcName(""); setCalcExpr("");
    }
    setAddingOp(null);
  }

  function handleApply() {
    const alias = outputAlias.trim() || `${sourceAlias}_step`;
    if (stepType === "output") {
      onApplyStep({ type: "output", output_alias: "output", target: sourceAlias });
    } else if (stepType === "clean") {
      if (!operations.length) return;
      onApplyStep({ type: "clean", output_alias: alias, target: sourceAlias, operations });
    } else if (stepType === "script") {
      onApplyStep({ type: "script", output_alias: alias, target: sourceAlias, script: scriptContent });
    }
    onClose();
  }

  const canApply =
    stepType === "output" ||
    (stepType === "clean" && operations.length > 0) ||
    stepType === "script";

  function opSummary(op: CleanOperation): string {
    if (op.op === "rename") return `Rename: ${Object.entries(op.mapping).map(([k, v]) => `${k} → ${v}`).join(", ")}`;
    if (op.op === "filter_values") return `Filter: ${op.conditions.map((c) => `${c.column} ${c.operator} ${c.value ?? ""}`).join(` ${op.logic ?? "AND"} `)}`;
    if (op.op === "dedup") return op.columns?.length ? `Dedup by: ${op.columns.join(", ")}` : "Dedup (all columns)";
    if (op.op === "calculate") return `${op.name} = ${op.expression}`;
    return "";
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/80 flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              {stepType ? (
                <>
                  <button onClick={() => setStepType(null)} className="text-blue-600 hover:underline cursor-pointer text-sm">Add Step</button>
                  <ChevronRight className="w-3 h-3 text-slate-400" />
                  <span>{STEP_TYPES.find((s) => s.id === stepType)?.label}</span>
                </>
              ) : "Add Step"}
              <span className="text-[11px] px-2 py-0.5 bg-blue-100 text-blue-700 font-mono rounded">
                after {sourceAlias}
              </span>
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {stepType ? "Configure your step below, then click Apply." : "Select the type of step to insert into your flow."}
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">

          {/* ── Step type picker ── */}
          {!stepType && (
            <div className="space-y-2">
              {STEP_TYPES.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => handleSelectStep(s.id)}
                    className="flex items-center gap-3 w-full px-4 py-3 rounded-xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50/40 text-left transition-all group cursor-pointer"
                  >
                    <span className="p-2 bg-slate-100 group-hover:bg-blue-100 rounded-lg text-slate-600 group-hover:text-blue-700 transition-colors shrink-0">
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-800 text-sm">{s.label}</span>
                        {s.badge && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${s.badge === "Required" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
                            {s.badge}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{s.description}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-blue-500 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}

          {/* ── OUTPUT ── */}
          {stepType === "output" && (
            <div className="flex flex-col items-center justify-center py-8 gap-4 text-center">
              <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-full">
                <ArrowRightToLine className="w-8 h-8 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">Mark as Flow Output</p>
                <p className="text-[11px] text-slate-500 mt-1 max-w-xs">
                  Marks <span className="font-mono font-semibold text-slate-700">{sourceAlias}</span> as the
                  final output of this flow. SQL is compiled automatically.
                </p>
              </div>
            </div>
          )}

          {/* ── SCRIPT ── */}
          {stepType === "script" && (
            <div className="space-y-3">
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-[11px]">
                Script steps are <strong>optional</strong> — SQL just passes rows through. Scripts run at execution time.
              </div>
              <label className="font-semibold text-slate-700 block">Script / Notes</label>
              <textarea
                value={scriptContent}
                onChange={(e) => setScriptContent(e.target.value)}
                rows={5}
                placeholder={"# Python / R script — runs at execution time\n# SQL passes all rows through this step unchanged"}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 focus:outline-none focus:border-blue-500 resize-y"
              />
            </div>
          )}

          {/* ── CLEAN STEP ── */}
          {stepType === "clean" && (
            <div className="space-y-4">

              {/* Operations already added */}
              {operations.length > 0 && (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-700">Operations in this Clean Step:</p>
                  {operations.map((op, idx) => (
                    <div key={idx} className="flex items-center justify-between px-3 py-2 bg-teal-50 rounded-lg border border-teal-200">
                      <span className="text-teal-800 font-mono text-[11px]">
                        {idx + 1}. {opSummary(op)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setOperations(operations.filter((_, i) => i !== idx))}
                        className="p-1 text-slate-400 hover:text-red-500 cursor-pointer"
                      >
                        <Trash className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Sub-action buttons (hidden while configuring one) */}
              {!addingOp && (
                <div className="space-y-2">
                  <p className="font-semibold text-slate-700">
                    {operations.length ? "Add another operation:" : "Add an operation:"}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {CLEAN_OPS.map((sa) => (
                      <button
                        key={sa.id}
                        type="button"
                        onClick={() => setAddingOp(sa.id)}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-200 hover:border-teal-400 hover:bg-teal-50/50 text-left cursor-pointer transition-all"
                      >
                        <Plus className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                        <div>
                          <div className="font-semibold text-slate-800 text-[11px]">{sa.label}</div>
                          <div className="text-[10px] text-slate-400 mt-0.5">{sa.desc}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ── (a) RENAME config ── */}
              {addingOp === "rename" && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-800">(a) Rename Columns</p>
                    <button type="button" onClick={() => setAddingOp(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                  {renamePairs.map((pair, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={pair.oldCol}
                        onChange={(e) => { const u = [...renamePairs]; u[idx].oldCol = e.target.value; setRenamePairs(u); }}
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-blue-500"
                      >
                        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <span className="text-slate-400 font-semibold">→</span>
                      <input
                        type="text"
                        value={pair.newCol}
                        onChange={(e) => { const u = [...renamePairs]; u[idx].newCol = e.target.value; setRenamePairs(u); }}
                        placeholder="new_name"
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-blue-500"
                      />
                      {renamePairs.length > 1 && (
                        <button type="button" onClick={() => setRenamePairs(renamePairs.filter((_, i) => i !== idx))} className="p-1 text-slate-400 hover:text-red-500 cursor-pointer">
                          <Trash className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setRenamePairs([...renamePairs, { oldCol: columns[0] || "", newCol: "" }])} className="text-xs text-blue-600 hover:text-blue-700 font-semibold cursor-pointer flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5" /> Add pair
                    </button>
                    <div className="flex-1" />
                    <button type="button" onClick={commitOp} className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5" /> Add to Step
                    </button>
                  </div>
                </div>
              )}

              {/* ── (b) FILTER VALUES config ── */}
              {addingOp === "filter_values" && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-800">(b) Filter Values</p>
                    <button type="button" onClick={() => setAddingOp(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">Condition logic:</span>
                    <select
                      value={filterLogic}
                      onChange={(e) => setFilterLogic(e.target.value as "AND" | "OR")}
                      className="bg-white border border-slate-300 rounded px-2 py-0.5 text-xs font-semibold"
                    >
                      <option value="AND">AND</option>
                      <option value="OR">OR</option>
                    </select>
                  </div>
                  {filterConds.map((cond, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={cond.column}
                        onChange={(e) => { const u = [...filterConds]; u[idx].column = e.target.value; setFilterConds(u); }}
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-2 py-1.5 font-mono text-xs focus:outline-none focus:border-blue-500"
                      >
                        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <select
                        value={cond.operator}
                        onChange={(e) => { const u = [...filterConds]; u[idx].operator = e.target.value; setFilterConds(u); }}
                        className="w-24 bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono font-semibold"
                      >
                        <option value="=">=</option>
                        <option value="!=">!=</option>
                        <option value=">">&gt;</option>
                        <option value="<">&lt;</option>
                        <option value=">=">&gt;=</option>
                        <option value="<=">&lt;=</option>
                        <option value="is_null">IS NULL</option>
                        <option value="is_not_null">NOT NULL</option>
                        <option value="LIKE">LIKE</option>
                      </select>
                      {!["is_null", "is_not_null"].includes(cond.operator) && (
                        <input
                          type="text"
                          value={cond.value}
                          onChange={(e) => { const u = [...filterConds]; u[idx].value = e.target.value; setFilterConds(u); }}
                          placeholder="Value"
                          className="flex-1 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-blue-500"
                        />
                      )}
                      {filterConds.length > 1 && (
                        <button type="button" onClick={() => setFilterConds(filterConds.filter((_, i) => i !== idx))} className="p-1 text-slate-400 hover:text-red-500 cursor-pointer">
                          <Trash className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setFilterConds([...filterConds, { column: columns[0] || "", operator: "=", value: "" }])} className="text-xs text-blue-600 hover:text-blue-700 font-semibold cursor-pointer flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5" /> Add condition
                    </button>
                    <div className="flex-1" />
                    <button type="button" onClick={commitOp} className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5" /> Add to Step
                    </button>
                  </div>
                </div>
              )}

              {/* ── (c) DEDUP config ── */}
              {addingOp === "dedup" && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-800">(c) Identify Duplicate Rows</p>
                    <button type="button" onClick={() => setAddingOp(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                  <p className="text-[11px] text-slate-500">Select columns to identify duplicates by (empty = deduplicate on all columns):</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto p-2 border border-slate-200 rounded-lg bg-white">
                    {columns.map((col) => {
                      const checked = dedupCols.includes(col);
                      return (
                        <label
                          key={col}
                          className={`flex items-center gap-2 p-2 rounded-md border text-xs cursor-pointer select-none ${checked ? "bg-indigo-50 border-indigo-300 text-indigo-900 font-medium" : "bg-white border-slate-200 text-slate-600"}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setDedupCols(e.target.checked ? [...dedupCols, col] : dedupCols.filter((c) => c !== col))}
                            className="rounded text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="truncate font-mono">{col}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="flex justify-end">
                    <button type="button" onClick={commitOp} className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5" /> Add to Step
                    </button>
                  </div>
                </div>
              )}

              {/* ── (d) CALCULATE config ── */}
              {addingOp === "calculate" && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-800">(d) Create Custom Calculated Field</p>
                    <button type="button" onClick={() => setAddingOp(null)} className="text-slate-400 hover:text-slate-600 cursor-pointer"><X className="w-4 h-4" /></button>
                  </div>
                  <input
                    type="text"
                    value={calcName}
                    onChange={(e) => setCalcName(e.target.value)}
                    placeholder="New column name  (e.g. full_name)"
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                  <textarea
                    rows={2}
                    value={calcExpr}
                    onChange={(e) => setCalcExpr(e.target.value)}
                    placeholder="SQL expression  (e.g. first_name || ' ' || last_name)"
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 font-mono text-xs focus:outline-none focus:border-blue-500 resize-none"
                  />
                  <div className="flex justify-end">
                    <button type="button" onClick={commitOp} className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5" /> Add to Step
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Output alias (all steps except output type) */}
          {stepType && stepType !== "output" && (
            <div className="pt-2 border-t border-slate-100">
              <label className="font-semibold text-slate-700 block mb-1">Resulting Node / Step Name</label>
              <input
                type="text"
                value={outputAlias}
                onChange={(e) => setOutputAlias(e.target.value)}
                placeholder="e.g. customers_cleaned"
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-800 focus:outline-none focus:border-blue-500"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        {stepType && (
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!canApply}
              className="px-4 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-all shadow-sm flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Apply {STEP_TYPES.find((s) => s.id === stepType)?.label} to Flow
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
