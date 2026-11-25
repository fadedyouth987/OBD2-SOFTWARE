"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Card, Field, Select, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, ROLE_LABEL, api, type CreatedInvite, type Team, type TeamRole } from "@/lib/api";
import { inviteExpiry, seatState } from "@/lib/team";

const INVITE_ROLES: { value: TeamRole; label: string }[] = [
  { value: "TECH", label: ROLE_LABEL.TECH },
  { value: "LEAD_TECH", label: ROLE_LABEL.LEAD_TECH },
];

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.offline ? "You're offline. Try again when you're connected." : e.message;
  return e instanceof Error ? e.message : String(e);
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <div className="space-y-2">
      <Field label="Invite link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="blue"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied("ok");
            } catch {
              setCopied("fail");
            }
          }}
        >
          Copy link
        </Button>
        <span role="status" className="text-xs text-muted">
          {copied === "ok" ? "Copied." : copied === "fail" ? "Couldn't copy. Select the link and copy it by hand." : ""}
        </span>
      </div>
    </div>
  );
}

export function TeamCard() {
  const { token, me } = useAuth();
  const [team, setTeam] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [invite, setInvite] = useState({ email: "", role: "TECH" as TeamRole, site_id: "" });
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [newSite, setNewSite] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setTeam(await api<Team>("/api/v1/team", { token }));
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load, me?.entitlements.tier]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <Card title="Team" className="lg:col-span-2">
        <Banner tone="danger" title="Couldn't load your team" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
          {loadError}
        </Banner>
      </Card>
    );
  }
  if (!team) {
    return (
      <Card title="Team" className="lg:col-span-2">
        <Skeleton className="h-40" />
      </Card>
    );
  }

  const s = seatState(team);
  const siteName = (id: string | null) => team.sites.find((x) => x.id === id)?.name ?? "No site";
  const siteOptions = [{ value: "", label: "No site" }, ...team.sites.map((x) => ({ value: x.id, label: x.name }))];
  const multiSite = team.sites_cap.limit > 1 || team.sites.length > 1;

  return (
    <Card
      title="Team"
      subtitle={`${team.seats.used} of ${team.seats.limit} seat${team.seats.limit === 1 ? "" : "s"} used${team.seats.pending ? `, ${team.seats.pending} invited` : ""}`}
      className="lg:col-span-2"
    >
      <div className="space-y-5">
        {error ? (
          <Banner tone="danger" title="Not done">
            {error}
          </Banner>
        ) : null}
        {s.over ? (
          <Banner tone="warn" title="More people than your plan includes">
            Everyone keeps access, but you can&apos;t invite anyone until you&apos;re within {team.seats.limit} seat
            {team.seats.limit === 1 ? "" : "s"}. <Link className="underline" href="/workshop/billing">Change plan</Link>
          </Banner>
        ) : null}

        <section aria-labelledby="team-members">
          <h3 id="team-members" className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
            Members
          </h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {team.members.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {m.display_name || m.email} {m.you ? <span className="text-xs font-normal text-muted">(you)</span> : null}
                  </span>
                  <span className="block truncate text-xs text-muted">{m.email}</span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {team.can_manage && m.role !== "OWNER" ? (
                    <>
                      <Select
                        label={`Role for ${m.email}`}
                        hideLabel
                        value={m.role}
                        options={INVITE_ROLES}
                        disabled={busy !== null}
                        onChange={(e) =>
                          void act(`role-${m.user_id}`, () =>
                            api(`/api/v1/team/members/${m.user_id}`, { method: "PATCH", body: { role: e.target.value }, token }),
                          )
                        }
                      />
                      {multiSite ? (
                        <Select
                          label={`Site for ${m.email}`}
                          hideLabel
                          value={m.site_id ?? ""}
                          options={siteOptions}
                          disabled={busy !== null}
                          onChange={(e) =>
                            void act(`site-${m.user_id}`, () =>
                              api(`/api/v1/team/members/${m.user_id}`, {
                                method: "PATCH",
                                body: e.target.value ? { site_id: e.target.value } : { clear_site: true },
                                token,
                              }),
                            )
                          }
                        />
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        busy={busy === `remove-${m.user_id}`}
                        disabled={busy !== null}
                        onClick={() => {
                          if (!window.confirm(`Remove ${m.email} from ${me?.workspace.name ?? "this workshop"}? They lose access straight away.`)) return;
                          void act(`remove-${m.user_id}`, () => api(`/api/v1/team/members/${m.user_id}`, { method: "DELETE", token }));
                        }}
                      >
                        Remove
                      </Button>
                    </>
                  ) : (
                    <>
                      <Badge tone={m.role === "OWNER" ? "accent" : "neutral"}>{ROLE_LABEL[m.role]}</Badge>
                      {multiSite && team.can_manage ? (
                        <Select
                          label={`Site for ${m.email}`}
                          hideLabel
                          value={m.site_id ?? ""}
                          options={siteOptions}
                          disabled={busy !== null}
                          onChange={(e) =>
                            void act(`site-${m.user_id}`, () =>
                              api(`/api/v1/team/members/${m.user_id}`, {
                                method: "PATCH",
                                body: e.target.value ? { site_id: e.target.value } : { clear_site: true },
                                token,
                              }),
                            )
                          }
                        />
                      ) : multiSite ? (
                        <span className="text-xs text-muted">{siteName(m.site_id)}</span>
                      ) : null}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {team.invites.length ? (
          <section aria-labelledby="team-invites">
            <h3 id="team-invites" className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
              Invited
            </h3>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {team.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{i.email}</span>
                    <span className="text-xs text-muted">
                      {ROLE_LABEL[i.role]}
                      {multiSite ? ` · ${siteName(i.site_id)}` : ""} ·{" "}
                      <span className={i.expired ? "text-warn" : undefined}>{inviteExpiry(i.expires_at)}</span>
                    </span>
                  </span>
                  {team.can_manage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === `revoke-${i.id}`}
                      disabled={busy !== null}
                      onClick={() => void act(`revoke-${i.id}`, () => api(`/api/v1/team/invites/${i.id}`, { method: "DELETE", token }))}
                    >
                      {i.expired ? "Remove" : "Revoke"}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {team.can_manage ? (
          <section aria-labelledby="team-invite" className="rounded-lg border border-line bg-raised p-3">
            <h3 id="team-invite" className="text-sm font-semibold">
              Invite someone
            </h3>
            {created ? (
              <div className="mt-2 space-y-2">
                <Banner tone="ok" title={`Invite ready for ${created.invite.email}`}>
                  Send them this link. It works once, for that email only, and expires in 7 days. We won&apos;t show it again.
                </Banner>
                <CopyLink url={created.invite_url} />
                <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  Done
                </Button>
              </div>
            ) : s.canInvite ? (
              <form
                className="mt-2 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy("invite");
                  setError(null);
                  try {
                    const r = await api<CreatedInvite>("/api/v1/team/invites", {
                      body: { email: invite.email, role: invite.role, site_id: invite.site_id || null },
                      token,
                    });
                    setCreated(r);
                    setInvite({ email: "", role: "TECH", site_id: "" });
                    await load();
                  } catch (err) {
                    setError(errText(err));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <Field label="Email" type="email" required autoComplete="off" value={invite.email} onChange={(e) => setInvite((v) => ({ ...v, email: e.target.value }))} />
                <Select label="Role" value={invite.role} options={INVITE_ROLES} onChange={(e) => setInvite((v) => ({ ...v, role: e.target.value as TeamRole }))} />
                {multiSite ? (
                  <Select label="Site" value={invite.site_id} options={siteOptions} onChange={(e) => setInvite((v) => ({ ...v, site_id: e.target.value }))} />
                ) : (
                  <span className="hidden sm:block" />
                )}
                <Button type="submit" variant="primary" busy={busy === "invite"} disabled={!invite.email || busy !== null}>
                  Create invite
                </Button>
              </form>
            ) : (
              <p className="mt-1 text-sm text-muted">
                {s.over || s.free === 0
                  ? `All ${team.seats.limit} seat${team.seats.limit === 1 ? " is" : "s are"} taken or invited. `
                  : ""}
                <Link className="underline" href="/workshop/billing">
                  {team.seats.limit === 1 ? "Workshop has 5 seats and Fleet has 10" : "Upgrade for more seats"}
                </Link>
                {team.invites.length ? ", or revoke an invite." : "."}
              </p>
            )}
            <p className="mt-2 text-xs text-faint">Only you, the owner, can manage the team and billing. Everyone on the team can see who&apos;s on it.</p>
          </section>
        ) : null}

        <section aria-labelledby="team-sites">
          <h3 id="team-sites" className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
            Sites ({team.sites_cap.used} of {team.sites_cap.limit})
          </h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {team.sites.map((site) => (
              <li key={site.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                {renaming?.id === site.id ? (
                  <form
                    className="flex flex-1 flex-wrap items-end gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const ok = await act(`rename-${site.id}`, () =>
                        api(`/api/v1/team/sites/${site.id}`, { method: "PATCH", body: { name: renaming.name }, token }),
                      );
                      if (ok) setRenaming(null);
                    }}
                  >
                    <Field label="Site name" className="flex-1" value={renaming.name} maxLength={120} onChange={(e) => setRenaming({ id: site.id, name: e.target.value })} />
                    <Button type="submit" size="sm" variant="blue" busy={busy === `rename-${site.id}`} disabled={!renaming.name.trim()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <>
                    <span>
                      <span className="block font-semibold">{site.name}</span>
                      <span className="text-xs text-muted">
                        {site.members} member{site.members === 1 ? "" : "s"}
                      </span>
                    </span>
                    {team.can_manage ? (
                      <span className="flex gap-1">
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setRenaming({ id: site.id, name: site.name })}>
                          Rename
                        </Button>
                        {team.sites.length > 1 ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            busy={busy === `delsite-${site.id}`}
                            disabled={busy !== null}
                            onClick={() => {
                              if (!window.confirm(`Delete ${site.name}? Its members stay on the team with no site set.`)) return;
                              void act(`delsite-${site.id}`, () => api(`/api/v1/team/sites/${site.id}`, { method: "DELETE", token }));
                            }}
                          >
                            Delete
                          </Button>
                        ) : null}
                      </span>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
          {s.canAddSite ? (
            <form
              className="mt-2 flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await act("addsite", () => api("/api/v1/team/sites", { body: { name: newSite }, token }));
                if (ok) setNewSite("");
              }}
            >
              <Field label="New site" className="flex-1" maxLength={120} value={newSite} onChange={(e) => setNewSite(e.target.value)} placeholder="e.g. North yard" />
              <Button type="submit" size="md" busy={busy === "addsite"} disabled={!newSite.trim() || busy !== null}>
                Add site
              </Button>
            </form>
          ) : team.can_manage && team.sites_cap.limit === 1 ? (
            <p className="mt-2 text-xs text-muted">
              More than one location? <Link className="underline" href="/workshop/billing">Fleet</Link> covers up to 3 sites.
            </p>
          ) : null}
        </section>
      </div>
    </Card>
  );
}
