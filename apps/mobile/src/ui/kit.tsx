import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Access } from "../plan/access";

export const color = {
  bg: "#0d1117",
  raised: "#161b22",
  line: "#30363d",
  text: "#e6edf3",
  muted: "#9da7b3",
  accent: "#f97316",
  ok: "#3fb950",
  warn: "#d29922",
  danger: "#f85149",
  info: "#58a6ff",
};

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
  const c = tone === "muted" ? color.muted : color[tone];
  return (
    <View style={[s.badge, { borderColor: c }]}>
      <Text style={[s.badgeText, { color: c }]}>{label}</Text>
    </View>
  );
}

export function Banner({ tone, title, children }: { tone: "ok" | "warn" | "danger" | "info"; title: string; children?: ReactNode }) {
  return (
    <View style={[s.banner, { borderLeftColor: color[tone] }]}>
      <Text style={s.bannerTitle}>{title}</Text>
      {children ? <Text style={[s.text, { color: color.muted }]}>{children}</Text> : null}
    </View>
  );
}

/** How a feature that isn't available on this plan is shown. No purchase links (Play policy). */
export function AccessNote({ access }: { access: Access }) {
  if (access.state === "available") return null;
  if (access.state === "locked") return <Banner tone="info" title={`Included in ${access.unlockWith} and higher plans`}>Your workshop owner can change the plan at app.rootcauseobd.com.au.</Banner>;
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
  screen: { flex: 1, backgroundColor: color.bg },
  body: { padding: 16, gap: 12 },
  card: { backgroundColor: color.raised, borderColor: color.line, borderWidth: 1, borderRadius: 12, padding: 16, gap: 8 },
  cardTitle: { color: color.text, fontSize: 16, fontWeight: "700" },
  text: { color: color.text, fontSize: 15, lineHeight: 21 },
  button: { backgroundColor: color.accent, borderRadius: 10, minHeight: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: color.line },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "700" },
  banner: { backgroundColor: color.raised, borderLeftWidth: 4, borderRadius: 8, padding: 12, gap: 4 },
  bannerTitle: { color: color.text, fontSize: 15, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 6, borderBottomColor: color.line, borderBottomWidth: StyleSheet.hairlineWidth },
});
