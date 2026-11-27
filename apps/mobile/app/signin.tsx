import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { ApiError } from "../src/api/client";
import { useApp } from "../src/state";
import { Banner, Body, Button, Card, color, Screen } from "../src/ui/kit";

export default function SignIn() {
  const { signIn } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      router.replace("/");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card title="Sign in to your workshop">
        <Body muted>Use the same email and password as the RootCause website.</Body>
        <TextInput style={s.input} placeholder="Email" placeholderTextColor={color.muted} autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail} />
        <TextInput style={s.input} placeholder="Password" placeholderTextColor={color.muted} secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} onSubmitEditing={() => void submit()} />
        {error ? <Banner tone="danger" title="Couldn't sign in">{error}</Banner> : null}
        <Button label="Sign in" busy={busy} disabled={!email || !password} onPress={() => void submit()} />
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  input: { borderWidth: 1, borderColor: color.line, borderRadius: 10, color: color.text, paddingHorizontal: 12, minHeight: 48, fontSize: 16 },
});
