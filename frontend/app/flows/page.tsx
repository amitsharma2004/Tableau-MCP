"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import { useActor } from "@/lib/actor-context";

export default function FlowsPage() {
  const { actorEmail } = useActor();
  const [flows, setFlows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listBackendFlows(actorEmail)
      .then(setFlows)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load flows"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-8 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Flows</h1>
          <p className="text-slate-600 mt-1">Canvas flows and Claude-generated flows, ready to run and publish.</p>
        </div>
        <Link href="/flows/new" className="btn-primary">
          New flow
        </Link>
      </div>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</p>}

      {loading ? (
        <p className="text-slate-500 text-sm">Loading...</p>
      ) : flows.length === 0 ? (
        <p className="text-slate-500 text-sm">No flows yet. Create one to get started.</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100">
          {flows.map((flow) => {
            const flowId = flow.flow_id as string;
            return (
              <Link
                key={flowId}
                href={`/flows/new?flowId=${flowId}`}
                className="p-4 flex items-center justify-between gap-4 hover:bg-slate-50 block"
              >
                <div>
                  <p className="font-medium text-slate-900">{flow.name as string}</p>
                  <p className="text-sm text-slate-500 line-clamp-1">
                    {flow.connection_id as string} · {flow.updated_at as string}
                  </p>
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-slate-100 text-slate-600 font-medium shrink-0">
                  {(flow.nodes as unknown[])?.length ?? 0} nodes
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
