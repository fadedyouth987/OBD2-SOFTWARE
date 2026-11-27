import { Redirect, router } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { TIER_NAME } from "../src/plan/access";
import { useApp } from "../src/state";
import { Badge, Banner, Body, Button, Card, color, Row, Screen } from "../src/ui/kit";

export default function Home() {
  const { ready, me, link, linkLost, signOut } = useApp();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: color.bg }}>
        <ActivityIndicator color={color.accent} />
      </View>
    );
  }
  if (!me) return <Redirect href="/signin" />;
  const tier = me.entitlements.tier;
  return (
    <Screen>
      <Card title={me.workspace.name}>
        <Row label="Plan" value={TIER_NAME[tier] ?? tier} />
        <Row label="AI diagnoses this month" value={`${me.usage.ai_diagnoses_used} of ${me.entitlements.ai_diagnoses}`} />
        <Button kind="ghost" label="What my plan includes" onPress={() => router.push("/plan")} />
      </Card>
      <Card title="Dongle">
        {linkLost ? <Banner tone="warn" title="Dongle disconnected">{linkLost}</Banner> : null}
        {link ? (
          <>
            <Badge tone="ok" label="Connected" />
            <Row label="Dongle" value={link.label} />
            <Row label="Battery" value={link.info.voltage ?? "Unknown"} />
            <Body muted>Read-only: this app never changes anything in the car.</Body>
          </>
        ) : (
          <Body muted>Plug the dongle into the car's OBD port, switch the ignition on, then connect.</Body>
        )}
        <Button label={link ? "Change dongle" : "Connect a dongle"} kind={link ? "ghost" : "primary"} onPress={() => router.push("/connect")} />
      </Card>
      <Button label="Scan the car" disabled={!link} onPress={() => router.push("/scan")} />
      <Button label="Live data" kind="ghost" disabled={!link} onPress={() => router.push("/live")} />
      <Button label="Sign out" kind="ghost" onPress={() => void signOut()} />
    </Screen>
  );
}
