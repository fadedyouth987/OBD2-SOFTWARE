"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Card } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, apiBlob, type StoredDbc } from "@/lib/api";
import { parseDbc, type Dbc } from "@/lib/dbc";
import { formatBytes } from "@/lib/format";
import { canDeleteFile } from "@/lib/permissions";

const MAX_DBC_BYTES = 2 * 1024 * 1024;

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.offline ? "You're offline." : e.message;
  return e instanceof Error ? e.message : String(e);
}

export interface LoadedDbc {
  name: string;
  dbc: Dbc;
  /** Set when the file came from this computer and isn't saved to the workshop yet. */
  localFile?: File;
  savedId?: string;
}

/** Load a DBC from this computer or from the workshop's saved files, and save it for the team. */
export function DbcCard({
  loaded,
  onLoad,
  liveIds,
  vehicleProfile,
}: {
  loaded: LoadedDbc | null;
  onLoad: (d: LoadedDbc) => void;
  liveIds: number[];
  vehicleProfile?: string | null;
}) {
  const { token, me } = useAuth();
  const [saved, setSaved] = useState<StoredDbc[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSavedError(null);
    try {
      setSaved((await api<{ items: StoredDbc[] }>("/api/v1/dbc", { token })).items);
    } catch (e) {
      setSavedError(errText(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = (name: string, text: string, extra: Partial<LoadedDbc>) => {
    const parsed = parseDbc(text);
    if (!parsed.messages.size) {
      setError("No messages (BO_) found. Is this a DBC file?");
      return;
    }
    onLoad({ name, dbc: parsed, ...extra });
  };

  return (
    <Card title="DBC file" subtitle="Decode frames with a CAN database. Save one to share it with your team.">
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="block text-xs font-semibold text-muted">Load from this computer</span>
          <input
            type="file"
            accept=".dbc,text/plain"
            className="mt-1 block w-full text-sm file:mr-3 file:min-h-[44px] file:rounded-lg file:border file:border-line file:bg-raised file:px-3 file:text-text"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setError(null);
              if (!f) return;
              if (f.size > MAX_DBC_BYTES) {
                setError("That file is over 2 MB; DBC files are usually much smaller.");
                return;
              }
              accept(f.name, await f.text(), { localFile: f });
            }}
          />
        </label>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {loaded ? (
          <div className="text-sm">
            <Badge tone="ok">Loaded</Badge> {loaded.name}: {loaded.dbc.messages.size} message{loaded.dbc.messages.size === 1 ? "" : "s"}
            {loaded.dbc.warnings.length ? (
              <span className="block text-xs text-warn">{loaded.dbc.warnings.length} lines couldn&apos;t be read and were skipped.</span>
            ) : null}
            <span className="block text-xs text-muted">
              {liveIds.filter((id) => loaded.dbc.messages.has(id)).length} of {liveIds.length} live IDs are defined in it.
            </span>
            {loaded.localFile && !loaded.savedId ? (
              <Button
                size="sm"
                className="mt-2"
                busy={busy === "save"}
                onClick={async () => {
                  setBusy("save");
                  setError(null);
                  const form = new FormData();
                  form.append("file", loaded.localFile!);
                  form.append("vehicle_profile", vehicleProfile ?? "");
                  try {
                    const r = await api<{ dbc: StoredDbc }>("/api/v1/dbc", { form, token });
                    onLoad({ ...loaded, localFile: undefined, savedId: r.dbc.id });
                    await load();
                  } catch (err) {
                    setError(errText(err));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Save to workshop
              </Button>
            ) : loaded.savedId ? (
              <span className="mt-1 block text-xs text-ok">Saved to your workshop.</span>
            ) : null}
          </div>
        ) : null}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Saved in your workshop</h3>
          {savedError ? (
            <Banner tone="warn" className="mt-1" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
              {savedError}
            </Banner>
          ) : !saved ? (
            <p className="mt-1 text-xs text-muted">Loading…</p>
          ) : !saved.length ? (
            <p className="mt-1 text-xs text-muted">None yet.</p>
          ) : (
            <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
              {saved.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{d.name}</span>
                    <span className="text-xs text-muted">
                      {d.message_count ?? "?"} message{d.message_count === 1 ? "" : "s"} · {formatBytes(d.size_bytes)}
                    </span>
                  </span>
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      busy={busy === `load-${d.id}`}
                      disabled={busy !== null || loaded?.savedId === d.id}
                      onClick={async () => {
                        setBusy(`load-${d.id}`);
                        setError(null);
                        try {
                          const text = await (await apiBlob(`/api/v1/dbc/${d.id}/file`, token)).text();
                          accept(d.name, text, { savedId: d.id });
                        } catch (err) {
                          setError(errText(err));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {loaded?.savedId === d.id ? "Loaded" : "Load"}
                    </Button>
                    {canDeleteFile(me, d.created_by) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === `del-${d.id}`}
                      disabled={busy !== null}
                      onClick={async () => {
                        if (!window.confirm(`Delete ${d.name} from your workshop?`)) return;
                        setBusy(`del-${d.id}`);
                        setError(null);
                        try {
                          await api(`/api/v1/dbc/${d.id}`, { method: "DELETE", token });
                          await load();
                        } catch (err) {
                          setError(errText(err));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      Delete
                    </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
