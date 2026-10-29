"use client";

import React, { useMemo } from "react";
import { Hash, Type, Calendar, CheckCircle2, AlertCircle, Sparkles, TrendingUp } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColMetric {
  name: string;
  type: "number" | "date" | "boolean" | "string";
  total: number;
  distinct: number;
  nulls: number;
  min?: number;
  max?: number;
  avg?: number;
  isAllUnique: boolean;
  topValues: { label: string; count: number; pct: number }[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferType(val: unknown): "number" | "date" | "boolean" | "string" {
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "number") return "number";
  if (typeof val === "string") {
    if (!isNaN(Number(val)) && val.trim() !== "") return "number";
    if (!isNaN(Date.parse(val)) && /\d{4}[-/]\d{2}/.test(val)) return "date";
  }
  return "string";
}

function TypeIcon({ type }: { type: string }) {
  if (type === "number")  return <Hash className="w-3 h-3" />;
  if (type === "date")    return <Calendar className="w-3 h-3" />;
  if (type === "boolean") return <CheckCircle2 className="w-3 h-3" />;
  return <Type className="w-3 h-3" />;
}

const TYPE_COLOR: Record<string, string> = {
  number:  "bg-blue-100 text-blue-700 border-blue-200",
  date:    "bg-emerald-100 text-emerald-700 border-emerald-200",
  boolean: "bg-purple-100 text-purple-700 border-purple-200",
  string:  "bg-slate-100 text-slate-600 border-slate-200",
};

const BAR_COLOR: Record<string, string> = {
  number:  "bg-blue-400",
  date:    "bg-emerald-400",
  boolean: "bg-purple-400",
  string:  "bg-teal-500",
};

// ── Category colour palette ───────────────────────────────────────────────────

const CAT_COLORS = [
  "bg-blue-400", "bg-emerald-400", "bg-purple-400", "bg-amber-400",
  "bg-rose-400",  "bg-cyan-400",   "bg-orange-400", "bg-indigo-400",
];

// ── Tooltip wrapper ───────────────────────────────────────────────────────────

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="group/tip relative">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-20
                      bg-slate-800 text-white text-[10px] font-semibold px-2 py-1 rounded-md shadow-lg
                      whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150">
        {label}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800" />
      </div>
    </div>
  );
}

// ── 1. Numeric: vertical bars min→max (height = value scaled to max) ──────────

const CHART_H = 56; // px — fixed chart area height

function NumericVerticalBars({ m }: { m: ColMetric }) {
  const sorted = [...m.topValues].sort((a, b) => Number(a.label) - Number(b.label));
  const maxVal = Math.max(...sorted.map((v) => Number(v.label)), 1);
  const barColor = BAR_COLOR[m.type];
  const hasNulls = m.nulls > 0;

  type Bar = { heightPx: number; tipLabel: string; color: string; isNull: boolean; axisLabel: string };

  const bars: Bar[] = [
    ...sorted.map((v) => ({
      heightPx: Math.max(Math.round((Number(v.label) / maxVal) * CHART_H), 4),
      tipLabel: m.isAllUnique
        ? `${v.label}`
        : `${v.label} — ${v.count} row${v.count !== 1 ? "s" : ""}`,
      color: barColor,
      isNull: false,
      axisLabel: Number(v.label) >= 1000
        ? `${Math.round(Number(v.label) / 1000)}k`
        : v.label,
    })),
    ...(hasNulls ? [{
      heightPx: Math.max(Math.round((m.nulls / m.total) * CHART_H), 4),
      tipLabel: `${m.nulls} null / empty row${m.nulls !== 1 ? "s" : ""}`,
      color: "bg-amber-300 border border-dashed border-amber-400",
      isNull: true,
      axisLabel: "∅",
    }] : []),
  ];

  return (
    <div className="pt-1 overflow-x-auto">
      {/* Chart area — fixed height, bars align at bottom */}
      <div className="flex items-end gap-1 min-w-fit" style={{ height: `${CHART_H}px` }}>
        {hasNulls && <div className="w-px bg-slate-200 self-stretch mr-0.5" />}
        {bars.map((bar, i) => (
          <Tip key={i} label={bar.tipLabel}>
            <div
              className={`w-5 shrink-0 rounded-t-sm ${bar.color} hover:opacity-70 transition-opacity cursor-default`}
              style={{ height: `${bar.heightPx}px` }}
            />
          </Tip>
        ))}
      </div>

      {/* X-axis value labels — one per bar, same gap */}
      <div className="flex gap-1 min-w-fit mt-0.5">
        {hasNulls && <div className="w-px mr-0.5" />}
        {bars.map((bar, i) => (
          <span
            key={i}
            className={`w-5 shrink-0 text-[8px] font-mono text-center block truncate leading-tight ${
              bar.isNull ? "text-amber-500" : "text-slate-400"
            }`}
            title={bar.axisLabel}
          >
            {bar.axisLabel}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── 2. Categorical: coloured horizontal bars by row % ────────────────────────

function CategoryBars({ values, total, nulls }: { values: ColMetric["topValues"]; total: number; nulls: number }) {
  return (
    <div className="space-y-1.5">
      {values.map((v, i) => {
        const color = CAT_COLORS[i % CAT_COLORS.length];
        const pct   = Math.round((v.count / total) * 100);
        return (
          <Tip key={i} label={`${v.count} rows (${pct}%)`}>
            <div>
              <div className="flex items-center justify-between text-[10px] mb-0.5">
                <span className="truncate max-w-[100px] font-medium text-slate-700" title={v.label}>
                  {v.label === "" ? <em className="text-slate-400">empty</em> : v.label}
                </span>
                <span className="font-mono text-slate-400 ml-1 shrink-0 text-[9px]">{v.count}</span>
              </div>
              <div className="h-[6px] w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${color} hover:opacity-75 transition-opacity cursor-default`}
                  style={{ width: `${Math.max(pct, 2)}%` }}
                />
              </div>
            </div>
          </Tip>
        );
      })}
      {nulls > 0 && (
        <Tip label={`${nulls} null / empty row${nulls !== 1 ? "s" : ""}`}>
          <div>
            <div className="flex items-center justify-between text-[10px] mb-0.5">
              <span className="italic text-amber-500 font-medium">null / empty</span>
              <span className="font-mono text-amber-400 ml-1 shrink-0 text-[9px]">{nulls}</span>
            </div>
            <div className="h-[6px] w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-amber-300 border border-dashed border-amber-400 hover:opacity-75 transition-opacity cursor-default"
                style={{ width: `${Math.max(Math.round((nulls / total) * 100), 2)}%` }}
              />
            </div>
          </div>
        </Tip>
      )}
    </div>
  );
}

// ── 3. High-cardinality / IDs: uniform-colour list with small bar ─────────────

function UniqueValueList({ values, barColor, nulls, total }: { values: ColMetric["topValues"]; barColor: string; nulls: number; total: number }) {
  return (
    <div className="space-y-1">
      {values.map((v, i) => (
        <Tip key={i} label={`${v.count} row${v.count !== 1 ? "s" : ""}`}>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${barColor}`} />
            <span className="text-[10px] text-slate-700 font-medium truncate" title={v.label}>
              {v.label === "" ? <em className="text-slate-400">empty</em> : v.label}
            </span>
          </div>
        </Tip>
      ))}
      {nulls > 0 && (
        <Tip label={`${nulls} null / empty row${nulls !== 1 ? "s" : ""} (${Math.round((nulls/total)*100)}%)`}>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-300 border border-amber-400" />
            <span className="text-[10px] italic text-amber-500 font-medium">{nulls} null / empty</span>
          </div>
        </Tip>
      )}
    </div>
  );
}

// ── 4. Boolean pill ───────────────────────────────────────────────────────────

function BooleanPill({ values, total }: { values: ColMetric["topValues"]; total: number }) {
  const trueRow   = values.find((v) => v.label === "true"  || v.label === "1");
  const falseRow  = values.find((v) => v.label === "false" || v.label === "0");
  const trueCount  = trueRow?.count  ?? 0;
  const falseCount = falseRow?.count ?? 0;
  const truePct    = Math.round((trueCount  / total) * 100);
  const falsePct   = Math.round((falseCount / total) * 100);
  return (
    <div className="pt-1 space-y-2">
      <div className="flex rounded-full overflow-hidden h-4 w-full">
        <Tip label={`True: ${trueCount} rows`}>
          <div className="bg-green-400 h-4 hover:opacity-75 transition-opacity cursor-default" style={{ width: `${truePct}%` }} />
        </Tip>
        <Tip label={`False: ${falseCount} rows`}>
          <div className="bg-red-300 h-4 hover:opacity-75 transition-opacity cursor-default" style={{ width: `${falsePct}%` }} />
        </Tip>
      </div>
      <div className="flex justify-between text-[10px] font-mono">
        <span className="text-green-700 font-semibold">✓ {trueCount} ({truePct}%)</span>
        <span className="text-red-500   font-semibold">✗ {falseCount} ({falsePct}%)</span>
      </div>
    </div>
  );
}

// ── Router ────────────────────────────────────────────────────────────────────

function DistributionArea({ m }: { m: ColMetric }) {
  const barColor = BAR_COLOR[m.type];

  if (m.topValues.length === 0)
    return <p className="text-[10px] text-slate-400 text-center py-3">No values</p>;

  if (m.type === "boolean")
    return <BooleanPill values={m.topValues} total={m.total} />;

  if (m.type === "number")
    return <NumericVerticalBars m={m} />;

  // String: categorical (few distinct relative to total) vs high-cardinality
  if (!m.isAllUnique)
    return <CategoryBars values={m.topValues} total={m.total} nulls={m.nulls} />;

  return <UniqueValueList values={m.topValues} barColor={barColor} nulls={m.nulls} total={m.total} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TableauDataProfiler({
  title,
  rows,
}: {
  title: string;
  rows: Record<string, unknown>[] | null;
  onCleanColumn?: (col: string, op: "trim" | "upper" | "lower") => void;
  onFilterColumn?: (col: string, val: string) => void;
}) {
  const metrics: ColMetric[] = useMemo(() => {
    if (!rows?.length) return [];
    const keys = Object.keys(rows[0]);
    const total = rows.length;

    return keys.map((col) => {
      const counts: Record<string, number> = {};
      let nulls = 0;
      let detectedType: ColMetric["type"] = "string";
      let sum = 0;
      let numCount = 0;
      let minVal: number | undefined;
      let maxVal: number | undefined;

      for (const r of rows) {
        const val = r[col];
        if (val === null || val === undefined || val === "") {
          nulls++;
          continue;
        }
        const strVal = String(val);
        counts[strVal] = (counts[strVal] || 0) + 1;
        const t = inferType(val);
        if (t !== "string") detectedType = t;
        if (t === "number") {
          const n = Number(val);
          sum += n;
          numCount++;
          if (minVal === undefined || n < minVal) minVal = n;
          if (maxVal === undefined || n > maxVal) maxVal = n;
        }
      }

      const distinctCount = Object.keys(counts).length;

      const topValues = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([label, count]) => ({
          label,
          count,
          pct: Math.round((count / total) * 100),
        }));

      return {
        name: col,
        type: detectedType,
        total,
        distinct: distinctCount,
        nulls,
        min: minVal,
        max: maxVal,
        avg: numCount ? Math.round((sum / numCount) * 100) / 100 : undefined,
        isAllUnique: distinctCount === total,   // ← new field
        topValues,
      };
    });
  }, [rows]);

  if (!rows?.length) {
    return (
      <div className="p-10 text-center bg-slate-50/60 border border-dashed border-slate-200 rounded-xl">
        <Sparkles className="w-7 h-7 text-slate-300 mx-auto mb-2" />
        <p className="text-xs font-semibold text-slate-700">No profile data</p>
        <p className="text-[11px] text-slate-400 mt-1">
          Click a node on the canvas to profile its data.
        </p>
      </div>
    );
  }

  // MCP-created flow internal node message
  const mcpMsg = rows[0]?.__mcp_message as string | undefined;
  if (mcpMsg) {
    return (
      <div className="p-8 text-center bg-blue-50/60 border border-blue-200 rounded-xl flex flex-col items-center gap-2">
        <TrendingUp className="w-6 h-6 text-blue-400" />
        <p className="text-xs font-semibold text-blue-800">MCP Flow — Internal Node</p>
        <p className="text-[11px] text-blue-600 max-w-sm leading-relaxed">{mcpMsg}</p>
      </div>
    );
  }

  const nullCols = metrics.filter((m) => m.nulls > 0).length;

  return (
    <div className="space-y-0">
      {/* ── Summary strip ── */}
      <div className="flex items-center gap-4 px-1 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-3.5 h-3.5 text-blue-500" />
          <span className="text-xs font-bold text-slate-800">{title}</span>
        </div>
        <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 font-semibold px-2 py-0.5 rounded-full font-mono">
          {rows.length} rows
        </span>
        <span className="text-[11px] bg-slate-100 text-slate-600 border border-slate-200 font-semibold px-2 py-0.5 rounded-full font-mono">
          {metrics.length} fields
        </span>
        {nullCols > 0 && (
          <span className="text-[11px] bg-amber-50 text-amber-700 border border-amber-200 font-semibold px-2 py-0.5 rounded-full flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {nullCols} field{nullCols > 1 ? "s" : ""} with nulls
          </span>
        )}
      </div>

      {/* ── Field profile cards ── */}
      <div className="flex gap-2.5 overflow-x-auto py-3 scrollbar-thin">
        {metrics.map((m) => {
          const typeClass = TYPE_COLOR[m.type];
          const nullPct   = Math.round((m.nulls / m.total) * 100);
          const filledPct = 100 - nullPct;

          return (
            <div
              key={m.name}
              className="w-48 shrink-0 bg-white border border-slate-200 rounded-lg overflow-hidden hover:border-blue-300 hover:shadow-md transition-all flex flex-col"
            >
              {/* Card top: type + name */}
              <div className="px-3 pt-2.5 pb-2 border-b border-slate-100 bg-slate-50/60">
                <div
                  className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border mb-1.5 ${typeClass}`}
                >
                  <TypeIcon type={m.type} />
                  {m.type === "number"
                    ? "Number"
                    : m.type === "date"
                    ? "Date"
                    : m.type === "boolean"
                    ? "Boolean"
                    : "String"}
                </div>
                <p className="text-xs font-bold text-slate-900 truncate" title={m.name}>
                  {m.name}
                </p>
                <div className="flex items-center justify-between mt-1.5 text-[10px] text-slate-500">
                  <span>{m.distinct} unique</span>
                  <span
                    className={
                      m.nulls > 0
                        ? "text-amber-600 font-semibold"
                        : "text-emerald-600 font-semibold"
                    }
                  >
                    {m.nulls === 0 ? "0 nulls" : `${nullPct}% null`}
                  </span>
                </div>
                {/* Fill / null bar */}
                <div className="mt-1 h-1 rounded-full overflow-hidden bg-slate-200 flex">
                  <div
                    className="bg-emerald-400 h-full transition-all"
                    style={{ width: `${filledPct}%` }}
                  />
                  {nullPct > 0 && (
                    <div
                      className="bg-amber-400 h-full transition-all"
                      style={{ width: `${nullPct}%` }}
                    />
                  )}
                </div>
              </div>

              {/* Numeric summary */}
              {m.type === "number" && m.min !== undefined && (
                <div className="px-3 py-1.5 bg-blue-50/50 border-b border-slate-100 flex justify-between text-[10px] text-slate-600 font-mono">
                  <span title="Min">▼ {m.min}</span>
                  {m.avg !== undefined && <span title="Avg">~ {m.avg}</span>}
                  <span title="Max">▲ {m.max}</span>
                </div>
              )}

              {/* Distribution area — smart rendering */}
              <div className="px-2.5 py-2 space-y-1 flex-1">
                <DistributionArea m={m} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Data grid ── */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto overflow-y-auto max-h-52">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-800 text-white sticky top-0 z-10">
                <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-slate-400 w-8 border-r border-slate-700 select-none">
                  #
                </th>
                {metrics.map((m) => (
                  <th
                    key={m.name}
                    className="px-3 py-1.5 text-left text-[10px] font-semibold tracking-wide border-r border-slate-700 last:border-r-0 whitespace-nowrap"
                  >
                    <div className="flex items-center gap-1">
                      <span
                        className={`opacity-70 ${
                          m.type === "number"
                            ? "text-blue-300"
                            : m.type === "date"
                            ? "text-emerald-300"
                            : m.type === "boolean"
                            ? "text-purple-300"
                            : "text-slate-300"
                        }`}
                      >
                        <TypeIcon type={m.type} />
                      </span>
                      <span className="truncate max-w-[120px]" title={m.name}>
                        {m.name}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr
                  key={ri}
                  className={`border-b border-slate-100 hover:bg-blue-50/40 transition-colors ${
                    ri % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                  }`}
                >
                  <td className="px-2 py-1 text-[10px] text-slate-400 font-mono border-r border-slate-100 select-none text-right">
                    {ri + 1}
                  </td>
                  {metrics.map((m) => {
                    const val = row[m.name];
                    const isNull = val === null || val === undefined;
                    return (
                      <td
                        key={m.name}
                        className="px-3 py-1 border-r border-slate-100 last:border-r-0 whitespace-nowrap max-w-[200px] truncate"
                        title={isNull ? "NULL" : String(val)}
                      >
                        {isNull ? (
                          <span className="text-amber-400 text-[10px] italic font-semibold">
                            null
                          </span>
                        ) : m.type === "number" ? (
                          <span className="font-mono text-blue-800 font-semibold">
                            {String(val)}
                          </span>
                        ) : m.type === "date" ? (
                          <span className="font-mono text-emerald-700">{String(val)}</span>
                        ) : m.type === "boolean" ? (
                          <span
                            className={`font-semibold ${
                              val ? "text-green-700" : "text-red-500"
                            }`}
                          >
                            {String(val)}
                          </span>
                        ) : (
                          <span className="text-slate-700">{String(val)}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-1.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <span className="text-[10px] text-slate-500">
            Showing {rows.length} sample rows
          </span>
          <span className="text-[10px] text-slate-400">{metrics.length} columns</span>
        </div>
      </div>
    </div>
  );
}
