"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { useJob } from "@/context/job";
import { ApiError, api, type Job, type Team } from "@/lib/api";
import { can } from "@/lib/permissions";

/** Who's on the job; lead technicians and owners can hand it to someone else. */
export function AssignControl() {
  const { job, setJob } = useJob();
  const { token, me } = useAuth();
  const [members, setMembers] = useState<Team["members"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = can(me, "MANAGE_ALL_JOBS");
  const open = job?.status === "OPEN";

  useEffect(() => {
    if (!manager || !open) return;
    api<Team>("/api/v1/team", { token })
      .then((t) => setMembers(t.members))
      .catch(() => setMembers(null));
  }, [manager, open, token]);

  if (!job) return null;
  const name = job.technician_name ?? (job.user_id === me?.user.id ? "You" : "Unassigned");
  if (!manager || !open || !members || members.length < 2) {
    return <span className="text-sm text-muted">Technician: {job.user_id === me?.user.id ? "you" : name}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Select
        label="Technician"
        value={job.user_id ?? ""}
        disabled={busy}
        options={[
          ...(job.user_id ? [] : [{ value: "", label: "Unassigned" }]),
          ...members.map((m) => ({ value: m.user_id, label: `${m.display_name || m.email}${m.you ? " (you)" : ""}` })),
        ]}
        onChange={async (e) => {
          const userId = e.target.value;
          if (!userId || userId === job.user_id) return;
          setBusy(true);
          setError(null);
          try {
            setJob(await api<Job>(`/api/v1/jobs/${job.id}/assign`, { body: { user_id: userId }, token }));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Couldn't reassign the job.");
          } finally {
            setBusy(false);
          }
        }}
      />
      {error ? (
        <span role="alert" className="text-xs text-danger-ink">
          {error}
        </span>
      ) : null}
    </span>
  );
}
