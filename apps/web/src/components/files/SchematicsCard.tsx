"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, Card, EmptyState, Field, Meter, Select, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, apiBlob, type Schematic, type VehiclePlatform } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";

const ACCEPT = "application/pdf,image/png,image/jpeg";
const MAX_BYTES = 25 * 1024 * 1024;

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.offline ? "You're offline. Try again when you're connected." : e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Workshop wiring schematics. With `vehicleProfile` it lists only that
 * vehicle's files and uploads are tagged with it (the job's Modules tab).
 */
export function SchematicsCard({
  vehicleProfile,
  platforms,
  className,
}: {
  vehicleProfile?: string | null;
  platforms?: VehiclePlatform[] | null;
  className?: string;
}) {
  const { token, me, refresh } = useAuth();
  const [items, setItems] = useState<Schematic[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [profile, setProfile] = useState(vehicleProfile ?? "");
  const input = useRef<HTMLInputElement>(null);

  const limit = me?.entitlements.schematic_pages ?? 0;
  const used = me?.usage.schematic_pages_used ?? 0;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const q = vehicleProfile ? `?vehicle_profile=${encodeURIComponent(vehicleProfile)}` : "";
      const r = await api<{ items: Schematic[] }>(`/api/v1/schematics${q}`, { token });
      setItems(r.items);
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [token, vehicleProfile]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (s: Schematic) => {
    setBusy(`open-${s.id}`);
    setError(null);
    // Open the tab synchronously (popup blockers), then point it at the file.
    const tab = window.open("", "_blank");
    try {
      const blob = await apiBlob(`/api/v1/schematics/${s.id}/file`, token);
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("That file is over 25 MB.");
      return;
    }
    setBusy("upload");
    setError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("title", title.trim());
    form.append("vehicle_profile", vehicleProfile ?? profile);
    try {
      await api("/api/v1/schematics", { form, token });
      setFile(null);
      setTitle("");
      if (input.current) input.current.value = "";
      await Promise.all([load(), refresh()]);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const platformName = (p: string | null) => {
    if (!p) return null;
    const hit = platforms?.find((x) => x.profile === p);
    return hit ? `${hit.make} ${hit.model}` : p;
  };

  return (
    <Card
      title="Wiring schematics"
      subtitle={vehicleProfile ? "Your workshop's diagrams for this vehicle." : "PDF or image wiring diagrams, private to your workshop."}
      className={className}
    >
      <div className="space-y-4">
        {limit > 0 ? (
          <Meter label="Schematic pages this month" used={used} limit={limit} />
        ) : (
          <Banner tone="info" title="Included from the Pro plan" action={<Link className="text-sm underline" href="/workshop/billing">See plans</Link>}>
            Upload wiring diagrams and open them next to the job.
          </Banner>
        )}
        {error ? (
          <Banner tone="danger" title="Not done">
            {error}
          </Banner>
        ) : null}
        {loadError ? (
          <Banner tone="danger" title="Couldn't load schematics" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
            {loadError}
          </Banner>
        ) : !items ? (
          <Skeleton className="h-20" />
        ) : !items.length ? (
          <EmptyState title="No schematics yet">
            {limit > 0 ? "Upload a PDF or a photo of a wiring diagram. Each page counts toward this month's allowance." : "Nothing uploaded."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{s.title}</span>
                  <span className="text-xs text-muted">
                    {[
                      s.page_count ? `${s.page_count} page${s.page_count === 1 ? "" : "s"}` : null,
                      formatBytes(s.size_bytes),
                      vehicleProfile ? null : platformName(s.vehicle_profile),
                      s.created_at ? formatDateTime(s.created_at) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex gap-1">
                  <Button size="sm" busy={busy === `open-${s.id}`} disabled={busy !== null} onClick={() => void open(s)}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === `del-${s.id}`}
                    disabled={busy !== null}
                    onClick={async () => {
                      if (!window.confirm(`Delete ${s.title}? Pages already used this month aren't given back.`)) return;
                      setBusy(`del-${s.id}`);
                      setError(null);
                      try {
                        await api(`/api/v1/schematics/${s.id}`, { method: "DELETE", token });
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
                </span>
              </li>
            ))}
          </ul>
        )}
        {limit > 0 ? (
          <form onSubmit={upload} className="grid gap-3 rounded-lg border border-line bg-raised p-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="schematic-file" className="block text-xs font-semibold text-muted">
                File (PDF, PNG or JPEG, up to 25 MB)
              </label>
              <input
                ref={input}
                id="schematic-file"
                type="file"
                accept={ACCEPT}
                className="mt-1 block w-full text-sm file:mr-3 file:min-h-[40px] file:rounded-lg file:border file:border-line file:bg-panel file:px-3 file:text-sm file:font-semibold file:text-text"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <Field label="Title" value={title} maxLength={200} placeholder={file?.name ?? "e.g. Engine loom, PCM connector"} onChange={(e) => setTitle(e.target.value)} />
            {vehicleProfile ? (
              <span className="hidden sm:block" />
            ) : (
              <Select
                label="Vehicle"
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                options={[{ value: "", label: "Any vehicle" }, ...(platforms ?? []).map((p) => ({ value: p.profile, label: `${p.make} ${p.model}` }))]}
              />
            )}
            <div className="sm:col-span-2">
              <Button type="submit" variant="blue" busy={busy === "upload"} disabled={!file || busy !== null}>
                Upload
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
