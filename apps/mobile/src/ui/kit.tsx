import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Access } from "../plan/access";

import { color, MIN_TARGET, radius } from "./tokens";

export { color };

/** Web Badge/Banner tones: info is the blue ink, as in the web's tone map. */
const TONE = { ok: color.ok, warn: color.warn, danger: color.danger, info: color.blueInk, muted: color.muted } as const;

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const body = <View style={s.body}>{children}</View>;
  return (
    <SafeAreaView style={s.screen} edges={["bottom", "left", "right"]}>
      {scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Card({ title, children, style }: { title?: string; children: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[s.text, muted && { color: color.muted }]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  kind = "primary",
  busy,
  disabled,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "ghost";
  busy?: boolean;
  disabled?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.button, kind === "ghost" && s.ghost, off && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
    >
      {busy ? <ActivityIndicator color={kind === "ghost" ? color.text : "#fff"} /> : <Text style={[s.buttonText, kind === "ghost" && { color: color.text }]}>{label}</Text>}
    </Pressable>
  );
}

export function Badge({ label, tone }: { label: string; tone: "ok" | "warn" | "danger" | "info" | "muted" }) {
  const c = TONE[tone];
  return (
    <View style={[s.badge, { borderColor: c }]}>
      <Text style={[s.badgeText, { color: c }]}>{label}</Text>
    </View>
  );
}

export function Banner({ tone, title, children }: { tone: "ok" | "warn" | "danger" | "info"; title: string; children?: ReactNode }) {
  return (
    <View style={[s.banner, { borderLeftColor: TONE[tone] }]}>
      <Text style={s.bannerTitle}>{title}</Text>
      {children ? <Text style={[s.text, { color: color.muted }]}>{children}</Text> : null}
    </View>
  );
}

/** How a feature that isn't available on this plan is shown. No purchase links (Play policy). */
export function AccessNote({ access }: { access: Access }) {
  if (access.state === "available") return null;
  if (access.state === "locked") return <Banner tone="info" title={`Included from the ${access.unlockWith} plan`}>Your workshop owner can change the plan at app.rootcauseobd.com.au.</Banner>;
  if (access.state === "quota_used") return <Banner tone="warn" title="This month's AI diagnoses are used">{`${access.quota.used} of ${access.quota.limit} used. They reset on the 1st.`}</Banner>;
  return <Banner tone="info" title="Desktop only">{access.why}</Banner>;
}

export function Row({ label, value, tone }: { label: string; value: string; tone?: keyof typeof color }) {
  return (
    <View style={s.row}>
      <Text style={[s.text, { color: color.muted, flex: 1 }]}>{label}</Text>
      <Text style={[s.text, { fontWeight: "600" }, tone && { color: color[tone] }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  // Same shapes as apps/web/src/components/ui.tsx: panel cards with a line border,
  // rounded-lg controls, 44 px targets, the brand red for primary actions.
  screen: { flex: 1, backgroundColor: color.bg },
  body: { padding: 16, gap: 16 },
  card: { backgroundColor: color.panel, borderColor: color.line, borderWidth: 1, borderRadius: radius.card, padding: 16, gap: 8 },
  cardTitle: { color: color.text, fontSize: 16, fontWeight: "700" },
  text: { color: color.text, fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: color.accent, borderRadius: radius.control, minHeight: MIN_TARGET, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  ghost: { backgroundColor: color.raised, borderWidth: 1, borderColor: color.line },
  buttonText: { color: color.accentText, fontSize: 14, fontWeight: "600" },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  banner: { backgroundColor: color.raised, borderLeftWidth: 4, borderRadius: radius.control, padding: 12, gap: 4 },
  bannerTitle: { color: color.text, fontSize: 14, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderBottomColor: color.line, borderBottomWidth: StyleSheet.hairlineWidth },
});
