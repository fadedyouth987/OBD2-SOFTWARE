"use client";

import { useCallback, useEffect, useState } from "react";
import { AccountUnavailable } from "@/components/shell/AccountUnavailable";
import { Badge, Banner, Button, ButtonLink, Card, PageHeader, Skeleton } from "@/components/ui";
import { useAuth } from "@/context/auth";
import { ApiError, api, type AccreditationOverview } from "@/lib/api";
import { SOURCE_LABEL, licenceChecklist, type LicenceItem } from "@/lib/licences";

function Item({ item }: { item: LicenceItem }) {
  return (
    <li className="grid gap-3 py-4 md:grid-cols-[1fr_auto]" data-testid={`licence-${item.id}`}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-bold">{item.title}</h3>
          <Badge tone={item.tone}>{item.badge}</Badge>
          {item.optional ? <span className="text-xs text-muted">Only for some jobs</span> : null}
        </div>
        <p className="text-sm">{item.detail}</p>
        <dl className="grid gap-x-4 gap-y-0.5 text-xs text-muted sm:grid-cols-[110px_1fr]">
          <dt>Unlocks</dt>
          <dd>{item.unlocks}</dd>
          <dt>Paid to</dt>
          <dd>{item.paidTo}</dd>
        </dl>
      </div>
      {item.action ? (
        <div className="md:self-center">
          <ButtonLink href={item.action.href} size="sm">
            {item.action.label}
          </ButtonLink>
        </div>
      ) : null}
    </li>
  );
}

export default function LicencesPage() {
  const { me, token } = useAuth();
  const [accreditation, setAccreditation] = useState<AccreditationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      setAccreditation(await api<AccreditationOverview>("/api/v1/accreditation", { token }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.offline ? "You're offline." : e.message) : String(e));
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!me) return <AccountUnavailable title="Licences & access" />;

  const items = licenceChecklist(me, accreditation);
  const groups: { source: LicenceItem["source"][]; title: string; subtitle: string }[] = [
    {
      source: ["rootcause"],
      title: SOURCE_LABEL.rootcause,
      subtitle: "Your subscription is the RootCause licence. Nothing else to buy from us.",
    },
    {
      source: ["aasra", "carmaker", "autoauth"],
      title: "Bought from other organisations",
      subtitle:
        "Australian law limits carmakers' security information to vetted technicians, so these come from AASRA, the carmaker or AutoAuth, not from RootCause. You only need them for the jobs listed.",
    },
  ];

  return (
    <>
      <PageHeader
        title="Licences & access"
        subtitle="What comes with your RootCause plan, and what you get elsewhere."
        actions={<ButtonLink href="/workshop">Back to workshop</ButtonLink>}
      />
      <div className="space-y-4">
        {error ? (
          <Banner tone="warn" title="Couldn't load accreditation status" action={<Button size="sm" onClick={() => void load()}>Retry</Button>}>
            {error}
          </Banner>
        ) : null}
        {groups.map((g) => (
          <Card key={g.title} title={g.title} subtitle={g.subtitle}>
            {!loaded && g.source.includes("aasra") ? (
              <Skeleton className="h-40" />
            ) : (
              <ul className="divide-y divide-line">
                {items
                  .filter((i) => g.source.includes(i.source))
                  .map((i) => (
                    <Item key={i.id} item={i} />
                  ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
