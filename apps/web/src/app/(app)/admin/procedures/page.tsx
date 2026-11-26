"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Card, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, type ProcedureCatalogue, type ProcedureImportResult } from "@/lib/api";
import { importProblems } from "@/lib/admin";
import { formatDate, formatDateTime } from "@/lib/format";

function resultText(r: ProcedureImportResult): string {
  const parts = [`${r.created} new`, `${r.updated} updated`, `${r.unchanged} unchanged`];
  if (r.withdrawn) parts.push(`${r.withdrawn} withdrawn`);
  return `${r.feed ? `${r.feed}: ` : ""}${r.source}: ${parts.join(", ")}.`;
}

export default function AdminProceduresPage() {
  const { token } = useAuth();
  const [cat, setCat] = useState<ProcedureCatalogue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ message: string; errors: { where: string; problem: string }[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setCat(await api<ProcedureCatalogue>("/api/v1/admin/procedures", { token }));
    } catch (e) {
      setLoadError(e instanceof ApiError && e.offline ? "You're offline." : e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNotice(null);
    setProblem(null);
    try {
      setNotice(await fn());
      await load();
    } catch (e) {
      setProblem(importProblems(e));
    } finally {
      setBusy(null);
    }
  };

  const importFile = (f: File) =>
    run("import", async () => {
      const form = new FormData();
      form.append("file", f);
      const r = await api<ProcedureImportResult>("/api/v1/admin/procedures/import", { method: "POST", form, token });
      if (file.current) file.current.value = "";
      return `Imported ${f.name}. ${resultText(r)}`;
    });

  return (
    <>
      <PageHeader
        title="OEM procedures"
        subtitle="Service procedures from licensed sources only. Technicians see “No verified procedure” for anything not covered here."
      />
      <div className="space-y-4">
        <Card title="Add or update procedures">
          <div className="space-y-3 text-sm">
            <p className="text-muted">
              Import a <span className="font-mono">rootcause.procedures/v1</span> JSON file from a licensed source. Every procedure is checked against
              the safety allowlist (no security access, writes or downloads). A changed procedure becomes a new version; the old one stays on record.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="procedure-file" className="sr-only">
                Procedure file
              </label>
              <input
                ref={file}
                id="procedure-file"
                type="file"
                accept="application/json,.json"
                disabled={Boolean(busy)}
                className="text-sm file:mr-3 file:min-h-[44px] file:rounded-lg file:border file:border-line file:bg-panel file:px-3 file:text-sm file:font-semibold file:text-text"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                }}
              />
              {busy === "import" ? <span className="text-muted">Checking and importing…</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <Button
                busy={busy === "sync"}
                disabled={Boolean(busy) || !cat?.feed_configured}
                onClick={() =>
                  void run("sync", async () => {
                    const r = await api<ProcedureImportResult>("/api/v1/admin/procedures/sync", { method: "POST", token });
                    return `Synced. ${resultText(r)}`;
                  })
                }
              >
                Sync from {cat?.feed_name ?? "licensed feed"}
              </Button>
              <span className="text-xs text-muted">
                {cat?.feed_configured
                  ? "Pulls the provider's current catalogue; anything they've dropped is withdrawn."
                  : "No feed configured. Set PROCEDURE_PROVIDER_FEED_URL and PROCEDURE_PROVIDER_API_KEY on the API server."}
              </span>
            </div>
            {notice ? <Banner tone="ok">{notice}</Banner> : null}
            {problem ? (
              <Banner tone="danger" title={problem.message}>
                {problem.errors.length ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {problem.errors.map((er, i) => (
                      <li key={i}>
                        {er.where ? <span className="font-mono">{er.where}</span> : null}
                        {er.where ? ": " : ""}
                        {er.problem}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Banner>
            ) : null}
          </div>
        </Card>

        {loadError ? (
          <Banner tone="danger" title="Couldn't load the catalogue" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
            {loadError}
          </Banner>
        ) : null}
        {!cat && !loadError ? <Skeleton className="h-64" /> : null}
        {cat ? (
          <>
            <Card title="Licensed sources">
              {cat.sources.length === 0 ? (
                <EmptyState title="No licensed sources yet">Import a file or sync a feed to add one.</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-2 pr-4">Source</th>
                        <th className="py-2 pr-4">Licence</th>
                        <th className="py-2 pr-4">Licensed until</th>
                        <th className="py-2 pr-4">Active procedures</th>
                        <th className="py-2">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {cat.sources.map((s) => {
                        const lapsed = s.licensed_until ? new Date(s.licensed_until) < new Date() : false;
                        return (
                          <tr key={s.id}>
                            <td className="py-2 pr-4">
                              <span className="font-semibold">{s.name}</span>
                              <span className="block font-mono text-xs text-faint">{s.key}</span>
                            </td>
                            <td className="py-2 pr-4">
                              {s.licence_url ? (
                                <a className="underline" href={s.licence_url} target="_blank" rel="noreferrer">
                                  {s.licence}
                                </a>
                              ) : (
                                s.licence
                              )}
                            </td>
                            <td className="py-2 pr-4">
                              {s.licensed_until ? formatDate(s.licensed_until) : "No end date"}
                              {lapsed ? (
                                <Badge tone="danger" className="ml-2">
                                  Lapsed: not shown
                                </Badge>
                              ) : null}
                            </td>
                            <td className="tabular py-2 pr-4">{s.active_procedures}</td>
                            <td className="py-2">{formatDateTime(s.updated_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="Recent procedure records">
              {cat.recent.length === 0 ? (
                <EmptyState title="No procedures imported" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-muted">
                      <tr>
                        <th className="py-2 pr-4">Procedure</th>
                        <th className="py-2 pr-4">Vehicle</th>
                        <th className="py-2 pr-4">Source ref</th>
                        <th className="py-2 pr-4">Status</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {cat.recent.map((r) => (
                        <tr key={r.id}>
                          <td className="py-2 pr-4">
                            <span className="font-mono text-xs">{r.function_id}</span>
                            <span className="block text-xs text-muted">{r.module}</span>
                          </td>
                          <td className="py-2 pr-4">
                            {r.make} {r.model} <span className="text-muted">{r.years}</span>
                          </td>
                          <td className="py-2 pr-4">
                            <span className="font-mono text-xs">{r.source_ref}</span>
                            <span className="block text-xs text-faint">
                              v{r.version} · {r.source ?? "—"} · {formatDateTime(r.imported_at)}
                            </span>
                          </td>
                          <td className="py-2 pr-4">
                            <Badge tone={r.status === "ACTIVE" ? "ok" : r.status === "WITHDRAWN" ? "danger" : "neutral"}>
                              {r.status === "ACTIVE" ? "Active" : r.status === "WITHDRAWN" ? "Withdrawn" : "Superseded"}
                            </Badge>
                          </td>
                          <td className="py-2 text-right">
                            {r.status === "ACTIVE" ? (
                              <Button
                                size="sm"
                                variant="danger"
                                busy={busy === r.id}
                                disabled={Boolean(busy)}
                                onClick={() => {
                                  if (!window.confirm(`Withdraw ${r.source_ref} v${r.version}? Technicians will stop seeing it.`)) return;
                                  void run(r.id, async () => {
                                    await api(`/api/v1/admin/procedures/${r.id}/withdraw`, { method: "POST", token });
                                    return `Withdrew ${r.source_ref} v${r.version}.`;
                                  });
                                }}
                              >
                                Withdraw
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        ) : null}
      </div>
    </>
  );
}
