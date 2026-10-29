"use client";

import React, { useState } from "react";
import { GitMerge, X, Check, Link2 } from "lucide-react";

export interface JoinColumnPickerProps {
  isOpen: boolean;
  onClose: () => void;
  leftTable: string;
  rightTable: string;
  leftColumns: string[];
  rightColumns: string[];
  onConfirm: (leftCol: string, rightCol: string) => void;
}

export function JoinColumnPicker({
  isOpen, onClose, leftTable, rightTable, leftColumns, rightColumns, onConfirm,
}: JoinColumnPickerProps) {
  const commonColumns = leftColumns.filter((c) => rightColumns.includes(c));

  const defaultLeft =
    commonColumns[0] ||
    leftColumns.find((c) => c.endsWith("_id")) ||
    leftColumns[0] || "";
  const defaultRight =
    commonColumns[0] ||
    rightColumns.find((c) => c.endsWith("_id")) ||
    rightColumns[0] || "";

  const [leftCol, setLeftCol] = useState(defaultLeft);
  const [rightCol, setRightCol] = useState(defaultRight);

  React.useEffect(() => {
    const cl = commonColumns[0] || leftColumns.find((c) => c.endsWith("_id")) || leftColumns[0] || "";
    const cr = commonColumns[0] || rightColumns.find((c) => c.endsWith("_id")) || rightColumns[0] || "";
    setLeftCol(cl);
    setRightCol(cr);
  }, [leftTable, rightTable, leftColumns, rightColumns]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/80 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-purple-100 text-purple-700 rounded-lg">
              <Link2 className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Select Join Key</h3>
              <p className="text-[11px] text-slate-500">
                <span className="font-mono text-slate-700">{leftTable}</span>
                <span className="mx-1 text-slate-400">⟷</span>
                <span className="font-mono text-slate-700">{rightTable}</span>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          {/* Common columns — quick-select chips */}
          {commonColumns.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-700">Common columns</span>
                <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-700 font-semibold rounded-full">
                  {commonColumns.length} match{commonColumns.length > 1 ? "es" : ""}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {commonColumns.map((col) => {
                  const selected = col === leftCol && col === rightCol;
                  return (
                    <button
                      key={col}
                      type="button"
                      onClick={() => { setLeftCol(col); setRightCol(col); }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-all cursor-pointer ${
                        selected
                          ? "bg-purple-600 border-purple-600 text-white shadow-sm"
                          : "bg-white border-slate-200 text-slate-700 hover:border-purple-400 hover:bg-purple-50"
                      }`}
                    >
                      {selected && <Check className="w-3 h-3" />}
                      {col}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Manual column selector (always shown, prefilled from common) */}
          <div className="space-y-2">
            <span className="font-semibold text-slate-700 block">
              {commonColumns.length ? "Or choose manually:" : "Select matching columns:"}
            </span>
            <div className="grid grid-cols-5 items-end gap-2">
              <div className="col-span-2">
                <label className="text-[10px] text-slate-500 font-mono block mb-1 truncate" title={leftTable}>
                  {leftTable}
                </label>
                <select
                  value={leftCol}
                  onChange={(e) => setLeftCol(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-purple-500"
                >
                  {leftColumns.map((c) => (
                    <option key={c} value={c}>
                      {rightColumns.includes(c) ? "★ " : ""}{c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-1 text-center pb-1.5 font-bold text-slate-400">=</div>
              <div className="col-span-2">
                <label className="text-[10px] text-slate-500 font-mono block mb-1 truncate" title={rightTable}>
                  {rightTable}
                </label>
                <select
                  value={rightCol}
                  onChange={(e) => setRightCol(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-purple-500"
                >
                  {rightColumns.map((c) => (
                    <option key={c} value={c}>
                      {leftColumns.includes(c) ? "★ " : ""}{c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!leftCol || !rightCol}
              onClick={() => onConfirm(leftCol, rightCol)}
              className="px-4 py-1.5 text-xs font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg shadow-sm flex items-center gap-1.5 disabled:opacity-40 cursor-pointer"
            >
              <GitMerge className="w-3.5 h-3.5" />
              Apply INNER Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
