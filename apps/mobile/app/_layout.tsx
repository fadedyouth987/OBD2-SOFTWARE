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
            headerStyle: { backgroundColor: color.raised },
            headerTintColor: color.text,
            contentStyle: { backgroundColor: color.bg },
          }}
        >
          <Stack.Screen name="index" options={{ title: "RootCause" }} />
          <Stack.Screen name="signin" options={{ title: "Sign in" }} />
          <Stack.Screen name="connect" options={{ title: "Connect a dongle" }} />
          <Stack.Screen name="scan" options={{ title: "Scan" }} />
          <Stack.Screen name="live" options={{ title: "Live data" }} />
          <Stack.Screen name="plan" options={{ title: "Your plan" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
