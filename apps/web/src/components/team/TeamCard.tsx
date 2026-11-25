"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Banner, Button, Card, Field, Select, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import {
  ApiError,
  ROLE_LABEL,
  api,
  type CreatedInvite,
  type EmailResult,
  type OwnershipTransfer,
  type Team,
  type TeamRole,
} from "@/lib/api";
import { formatDateTime, relative } from "@/lib/format";
import { abilities, confirmNameMatches, describeAuditEvent, inviteExpiry, seatState } from "@/lib/team";

const ROLE_OPTIONS: { value: TeamRole; label: string }[] = [
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

/** What happened to the invite email, and the copy-link fallback. */
function InviteSent({ created, emailEnabled, onDone }: { created: CreatedInvite; emailEnabled: boolean; onDone: () => void }) {
  const email: EmailResult | undefined = created.email;
  const to = created.invite.email;
  return (
    <div className="mt-2 space-y-2">
      {email?.sent ? (
        <Banner tone="ok" title={`Invite emailed to ${to}`}>
          They&apos;ll get a link that works once, for that email only, for 7 days. If it doesn&apos;t arrive, send them the link below.
        </Banner>
      ) : emailEnabled ? (
        <Banner tone="warn" title={`Couldn't email ${to}`}>
          {email?.error ? `${email.error} ` : ""}Send them this link instead. It works once, for that email only, and expires in 7 days.
        </Banner>
      ) : (
        <Banner tone="ok" title={`Invite ready for ${to}`}>
          Email isn&apos;t set up on this server, so send them this link. It works once, for that email only, and expires in 7 days.
          We won&apos;t show it again.
        </Banner>
      )}
      <CopyLink url={created.invite_url} />
      <Button size="sm" variant="ghost" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

function OwnershipBanner({
  offer,
  workshop,
  busy,
  onAccept,
  onDecline,
  onCancel,
  isOwner,
}: {
  offer: OwnershipTransfer;
  workshop: string;
  busy: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
  isOwner: boolean;
}) {
  const until = `The offer ends ${relative(offer.expires_at)} (${formatDateTime(offer.expires_at)}).`;
  if (offer.for_you) {
    return (
      <Banner
        tone="accent"
        title={`${offer.from_name} wants to hand ${workshop} over to you`}
        action={
          <span className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" busy={busy === "accept"} disabled={busy !== null} onClick={onAccept}>
              Accept ownership
            </Button>
            <Button size="sm" variant="ghost" busy={busy === "decline"} disabled={busy !== null} onClick={onDecline}>
              Decline
            </Button>
          </span>
        }
      >
        As owner you&apos;ll manage billing, the team and the workshop&apos;s accreditation. {offer.from_name} stays on as a lead
        technician. {until}
      </Banner>
    );
  }
  return (
    <Banner
      tone="info"
      title={`Ownership offered to ${offer.to_name}`}
      action={
        isOwner ? (
          <Button size="sm" variant="ghost" busy={busy === "cancel-offer"} disabled={busy !== null} onClick={onCancel}>
            Cancel offer
          </Button>
        ) : undefined
      }
    >
      Nothing changes until {offer.to_name} accepts. {until}
    </Banner>
  );
}

export function TeamCard() {
  const { token, me, refresh } = useAuth();
  const [team, setTeam] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [invite, setInvite] = useState({ email: "", role: "TECH" as TeamRole, site_id: "" });
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [newSite, setNewSite] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [handover, setHandover] = useState({ to: "", confirm: "" });

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
  }, [load, me?.entitlements.tier, me?.workspace.role]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
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

  const a = abilities(team);
  const s = seatState(team);
  const workshop = me?.workspace.name ?? "this workshop";
  const isOwner = me?.workspace.role === "OWNER";
  const emailEnabled = team.email_enabled ?? false;
  const siteName = (id: string | null) => team.sites.find((x) => x.id === id)?.name ?? "No site";
  const siteOptions = [{ value: "", label: "No site" }, ...team.sites.map((x) => ({ value: x.id, label: x.name }))];
  const multiSite = team.sites_cap.limit > 1 || team.sites.length > 1;
  const inviteRoles = ROLE_OPTIONS.filter((r) => a.invite_roles.includes(r.value));
  const offer = team.ownership_transfer ?? null;
  const handoverCandidates = team.members.filter((m) => !m.you && m.role !== "OWNER");

  const setSite = (userId: string, siteId: string) =>
    void act(`site-${userId}`, () =>
      api(`/api/v1/team/members/${userId}`, {
        method: "PATCH",
        body: siteId ? { site_id: siteId } : { clear_site: true },
        token,
      }),
    );

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
        {notice ? <Banner tone="ok">{notice}</Banner> : null}
        {offer ? (
          <OwnershipBanner
            offer={offer}
            workshop={workshop}
            busy={busy}
            isOwner={isOwner}
            onAccept={async () => {
              const ok = await act("accept", () => api(`/api/v1/team/ownership-transfer/${offer.id}/accept`, { method: "POST", token }));
              if (ok) {
                setNotice(`You're now the owner of ${workshop}.`);
                await refresh();
              }
            }}
            onDecline={async () => {
              const ok = await act("decline", () => api(`/api/v1/team/ownership-transfer/${offer.id}/decline`, { method: "POST", token }));
              if (ok) setNotice("You declined. Nothing changed.");
            }}
            onCancel={async () => {
              const ok = await act("cancel-offer", () => api("/api/v1/team/ownership-transfer", { method: "DELETE", token }));
              if (ok) setNotice("Offer cancelled.");
            }}
          />
        ) : null}
        {s.over ? (
          <Banner tone="warn" title="More people than your plan includes">
            Everyone keeps access, but you can&apos;t invite anyone until you&apos;re within {team.seats.limit} seat
            {team.seats.limit === 1 ? "" : "s"}. {isOwner ? <Link className="underline" href="/workshop/billing">Change plan</Link> : "Ask the owner to change plan."}
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
                  {a.change_roles && m.role !== "OWNER" && !m.you ? (
                    <Select
                      label={`Role for ${m.email}`}
                      hideLabel
                      value={m.role}
                      options={ROLE_OPTIONS}
                      disabled={busy !== null}
                      onChange={(e) =>
                        void act(`role-${m.user_id}`, () =>
                          api(`/api/v1/team/members/${m.user_id}`, { method: "PATCH", body: { role: e.target.value }, token }),
                        )
                      }
                    />
                  ) : (
                    <Badge tone={m.role === "OWNER" ? "accent" : m.role === "LEAD_TECH" ? "info" : "neutral"}>{ROLE_LABEL[m.role]}</Badge>
                  )}
                  {multiSite && a.manage_sites ? (
                    <Select
                      label={`Site for ${m.email}`}
                      hideLabel
                      value={m.site_id ?? ""}
                      options={siteOptions}
                      disabled={busy !== null}
                      onChange={(e) => setSite(m.user_id, e.target.value)}
                    />
                  ) : multiSite ? (
                    <span className="text-xs text-muted">{siteName(m.site_id)}</span>
                  ) : null}
                  {a.remove_members && m.role !== "OWNER" && !m.you ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === `remove-${m.user_id}`}
                      disabled={busy !== null}
                      onClick={() => {
                        if (!window.confirm(`Remove ${m.email} from ${workshop}? They lose access straight away.`)) return;
                        void act(`remove-${m.user_id}`, () => api(`/api/v1/team/members/${m.user_id}`, { method: "DELETE", token }));
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
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
              {team.invites.map((i) => {
                const mayManage = a.revoke_invites && a.invite_roles.includes(i.role);
                return (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{i.email}</span>
                      <span className="text-xs text-muted">
                        {ROLE_LABEL[i.role]}
                        {multiSite ? ` · ${siteName(i.site_id)}` : ""} ·{" "}
                        <span className={i.expired ? "text-warn" : undefined}>{inviteExpiry(i.expires_at)}</span>
                      </span>
                    </span>
                    {mayManage ? (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={busy === `resend-${i.id}`}
                          disabled={busy !== null}
                          onClick={async () => {
                            setBusy(`resend-${i.id}`);
                            setError(null);
                            try {
                              setCreated(await api<CreatedInvite>(`/api/v1/team/invites/${i.id}/resend`, { method: "POST", token }));
                              await load();
                            } catch (err) {
                              setError(errText(err));
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          {emailEnabled ? "Resend" : "New link"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          busy={busy === `revoke-${i.id}`}
                          disabled={busy !== null}
                          onClick={() => void act(`revoke-${i.id}`, () => api(`/api/v1/team/invites/${i.id}`, { method: "DELETE", token }))}
                        >
                          {i.expired ? "Remove" : "Revoke"}
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {a.invite ? (
          <section aria-labelledby="team-invite" className="rounded-lg border border-line bg-raised p-3">
            <h3 id="team-invite" className="text-sm font-semibold">
              Invite someone
            </h3>
            {created ? (
              <InviteSent created={created} emailEnabled={emailEnabled} onDone={() => setCreated(null)} />
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
                <Select label="Role" value={invite.role} options={inviteRoles} onChange={(e) => setInvite((v) => ({ ...v, role: e.target.value as TeamRole }))} />
                {multiSite ? (
                  <Select label="Site" value={invite.site_id} options={siteOptions} onChange={(e) => setInvite((v) => ({ ...v, site_id: e.target.value }))} />
                ) : (
                  <span className="hidden sm:block" />
                )}
                <Button type="submit" variant="primary" busy={busy === "invite"} disabled={!invite.email || busy !== null}>
                  {emailEnabled ? "Send invite" : "Create invite"}
                </Button>
              </form>
            ) : (
              <p className="mt-1 text-sm text-muted">
                {s.over || s.free === 0
                  ? `All ${team.seats.limit} seat${team.seats.limit === 1 ? " is" : "s are"} taken or invited. `
                  : ""}
                {isOwner ? (
                  <Link className="underline" href="/workshop/billing">
                    {team.seats.limit === 1 ? "Workshop has 5 seats and Fleet has 10" : "Upgrade for more seats"}
                  </Link>
                ) : (
                  "Ask the owner about more seats"
                )}
                {team.invites.length ? ", or revoke an invite." : "."}
              </p>
            )}
            <p className="mt-2 text-xs text-faint">
              {isOwner
                ? "Owners manage billing, roles and ownership. Lead technicians can invite technicians and manage everyone's jobs."
                : "As a lead technician you can invite technicians and manage everyone's jobs. Billing, roles and ownership stay with the owner."}
              {emailEnabled ? "" : " Invites are shared as links because email isn't set up on this server."}
            </p>
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
                    {a.manage_sites ? (
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
          ) : a.manage_sites && team.sites_cap.limit === 1 ? (
            <p className="mt-2 text-xs text-muted">
              More than one location? <Link className="underline" href="/workshop/billing">Fleet</Link> covers up to 3 sites.
            </p>
          ) : null}
        </section>

        {a.transfer_ownership && !offer ? (
          <section aria-labelledby="team-handover" className="rounded-lg border border-line p-3">
            <h3 id="team-handover" className="text-sm font-semibold">
              Hand over ownership
            </h3>
            {handoverCandidates.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Invite someone first. Ownership can only go to a member of this workshop.</p>
            ) : (
              <form
                className="mt-2 space-y-3"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const target = team.members.find((m) => m.user_id === handover.to);
                  const ok = await act("offer", () =>
                    api("/api/v1/team/ownership-transfer", { body: { to_user_id: handover.to, confirm_name: handover.confirm }, token }),
                  );
                  if (ok) {
                    setHandover({ to: "", confirm: "" });
                    setNotice(`Offer sent to ${target?.display_name || target?.email || "them"}. They have 72 hours to accept.`);
                  }
                }}
              >
                <p className="text-sm text-muted">
                  The new owner takes over billing, roles and the workshop&apos;s accreditation. You stay on as a lead technician. They
                  must accept before anything changes.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Select
                    label="New owner"
                    value={handover.to}
                    options={[{ value: "", label: "Choose a member" }, ...handoverCandidates.map((m) => ({ value: m.user_id, label: m.display_name || m.email }))]}
                    onChange={(e) => setHandover((v) => ({ ...v, to: e.target.value }))}
                  />
                  <Field
                    label={`Type “${workshop}” to confirm`}
                    autoComplete="off"
                    value={handover.confirm}
                    onChange={(e) => setHandover((v) => ({ ...v, confirm: e.target.value }))}
                  />
                </div>
                <Button
                  type="submit"
                  variant="danger"
                  busy={busy === "offer"}
                  disabled={!handover.to || !confirmNameMatches(handover.confirm, workshop) || busy !== null}
                >
                  Offer ownership
                </Button>
              </form>
            )}
          </section>
        ) : null}

        {a.view_history && team.history && team.history.length ? (
          <section aria-labelledby="team-history">
            <h3 id="team-history" className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
              Recent team changes
            </h3>
            <ul className="divide-y divide-line rounded-lg border border-line text-sm">
              {team.history.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
                  <span>{describeAuditEvent(e)}</span>
                  <time className="text-xs text-muted" dateTime={e.at ?? undefined} title={formatDateTime(e.at)}>
                    {relative(e.at)}
                  </time>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Card>
  );
}
