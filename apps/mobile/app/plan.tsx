import { APP_FEATURES, access, TIER_NAME, type FeatureKey } from "../src/plan/access";
import { useApp } from "../src/state";
import { Badge, Body, Card, Screen } from "../src/ui/kit";

export default function Plan() {
  const { me } = useApp();
  const tier = me?.entitlements.tier ?? "COMMUNITY";
  return (
    <Screen>
      <Card title={`${TIER_NAME[tier]} plan`}>
        <Body muted>Everything the app can do, and whether your plan includes it.</Body>
      </Card>
      {APP_FEATURES.map((f) => {
        const a = access(f.key as FeatureKey, me);
        const badge =
          a.state === "available" ? <Badge tone="ok" label="Included" />
          : a.state === "quota_used" ? <Badge tone="warn" label="Used up this month" />
          : a.state === "locked" ? <Badge tone="muted" label={`${a.unlockWith} and up`} />
          : <Badge tone="info" label="Desktop only" />;
        return (
          <Card key={f.key} title={f.label}>
            {badge}
            <Body muted>{a.state === "desktop_only" ? a.why : f.what}</Body>
            {a.state === "available" && a.quota ? <Body muted>{`${a.quota.left} of ${a.quota.limit} left this month`}</Body> : null}
          </Card>
        );
      })}
    </Screen>
  );
}
