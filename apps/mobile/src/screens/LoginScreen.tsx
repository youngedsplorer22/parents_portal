import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ApiError, type Api, type User } from "../api/client";
import { colors, radius } from "../ui/theme";

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "The email or password is incorrect.",
  RATE_LIMITED: "Too many attempts. Please wait a few minutes and try again.",
  SERVER_BUSY: "The server is busy. Please try again in a few seconds.",
  NETWORK_ERROR: "No connection to the portal. Check your internet and try again.",
  VALIDATION_ERROR: "Enter your email address and password.",
};

/** Sign in with the same email and password as the Parents Portal website. */
export default function LoginScreen({ api, notice, onSignedIn }: { api: Api; notice?: string | null; onSignedIn: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (!email.trim() || !password) return setError(MESSAGES.VALIDATION_ERROR ?? null);
    setBusy(true);
    setError(null);
    try {
      const user = await api.login(email, password);
      setPassword("");
      onSignedIn(user);
    } catch (err) {
      setPassword("");
      setError(MESSAGES[err instanceof ApiError ? err.code : "NETWORK_ERROR"] ?? "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>Young Edsplorer</Text>
        <Text style={styles.title}>Team Leader sign in</Text>
        <Text style={styles.sub}>Use the email and password of your Parents Portal account. Trips appear here once the Young Edsplorer team has made you their team lead.</Text>
        {notice ? <Text style={styles.notice} accessibilityRole="alert">{notice}</Text> : null}
        <Text style={styles.label} nativeID="email-label">Email address</Text>
        <TextInput accessibilityLabelledBy="email-label" accessibilityLabel="Email address" style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" placeholder="you@example.com" editable={!busy} />
        <Text style={styles.label} nativeID="password-label">Password</Text>
        <TextInput accessibilityLabelledBy="password-label" accessibilityLabel="Password" style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" placeholder="Your password" editable={!busy} onSubmitEditing={submit} />
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        <Pressable accessibilityRole="button" style={({ pressed }) => [styles.button, (busy || pressed) && styles.buttonDim]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>
        <View style={styles.help}>
          <Text style={styles.helpText}>Forgot your password? Reset it on the Parents Portal website, then sign in here.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.canvas },
  page: { padding: 24, paddingTop: 72, gap: 8 },
  brand: { color: colors.brand, fontWeight: "700", fontSize: 15, letterSpacing: 0.5 },
  title: { color: colors.ink, fontSize: 26, fontWeight: "700", marginTop: 4 },
  sub: { color: colors.muted, fontSize: 15, lineHeight: 21, marginBottom: 12 },
  notice: { backgroundColor: colors.brandSoft, color: colors.brandInk, padding: 12, borderRadius: radius, fontSize: 14, marginBottom: 8 },
  label: { color: colors.ink2, fontWeight: "600", fontSize: 14, marginTop: 10 },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: "#d5deea", borderRadius: 10, paddingHorizontal: 14, minHeight: 48, fontSize: 16, color: colors.ink },
  error: { color: colors.danger, backgroundColor: colors.dangerSoft, padding: 10, borderRadius: 10, marginTop: 10, fontSize: 14 },
  button: { backgroundColor: colors.brand, minHeight: 50, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: 18 },
  buttonDim: { opacity: 0.75 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  help: { marginTop: 20 },
  helpText: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
