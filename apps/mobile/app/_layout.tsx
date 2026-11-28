import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "../src/state";
import { color } from "../src/ui/kit";

export default function Layout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            // Same as the web's top bar: panel surface, line under it, bold title.
            headerStyle: { backgroundColor: color.panel },
            headerTintColor: color.text,
            headerTitleStyle: { fontWeight: "700", fontSize: 16 },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: color.bg },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
          <Stack.Screen name="dongle/index" options={{ title: "Phone dongle (read-only)" }} />
          <Stack.Screen name="dongle/connect" options={{ title: "Connect a dongle" }} />
          <Stack.Screen name="dongle/scan" options={{ title: "Scan" }} />
          <Stack.Screen name="dongle/live" options={{ title: "Live data" }} />
          <Stack.Screen name="dongle/plan" options={{ title: "What your plan includes" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
