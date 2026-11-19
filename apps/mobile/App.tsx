import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { ApiError, type TripView, type User } from "./src/api/client";
import { getApi } from "./src/api/instance";
import { ConfigError } from "./src/config";
import { stopSharing } from "./src/location/sharing";
import LoginScreen from "./src/screens/LoginScreen";
import SharingScreen from "./src/screens/SharingScreen";
import TripsScreen from "./src/screens/TripsScreen";
import { colors } from "./src/ui/theme";

type Screen = { name: "loading" } | { name: "login"; notice?: string } | { name: "trips"; user: User } | { name: "sharing"; user: User; trip: TripView } | { name: "config"; message: string };

/** Sign in -> My trips -> one trip's sharing screen. A returning team lead goes straight to their trips. */
function apiOrProblem() {
  try {
    return { api: getApi(), problem: null };
  } catch (err) {
    return { api: null, problem: err instanceof ConfigError ? err.message : "The app is not configured." };
  }
}

export default function App() {
  const [{ api, problem }] = useState(apiOrProblem);
  const [screen, setScreen] = useState<Screen>(() => (problem ? { name: "config", message: problem } : { name: "loading" }));

  useEffect(() => {
    if (!api) return;
    (async () => {
      if (!(await api.hasSession())) return setScreen({ name: "login" });
      try {
        setScreen({ name: "trips", user: await api.me() });
      } catch (err) {
        setScreen(err instanceof ApiError && err.code === "UNAUTHENTICATED" ? { name: "login", notice: "Your sign-in has ended. Please sign in again." } : { name: "login", notice: "Couldn't reach the portal. Check your connection." });
      }
    })();
  }, [api]);

  const sessionEnded = useCallback(() => setScreen({ name: "login", notice: "Your sign-in has ended. Please sign in again." }), []);
  const signOut = useCallback(async () => {
    if (!api) return;
    await stopSharing(api).catch(() => {}); // signing out always stops sharing (the server also wipes the position)
    await api.logout();
    setScreen({ name: "login" });
  }, [api]);

  let body;
  if (screen.name === "config") body = <View style={styles.center}><Text style={styles.title}>App not configured</Text><Text style={styles.text}>{screen.message}</Text></View>;
  else if (screen.name === "loading" || !api) body = <View style={styles.center}><ActivityIndicator /></View>;
  else if (screen.name === "login") body = <LoginScreen api={api} notice={screen.notice} onSignedIn={(user) => setScreen({ name: "trips", user })} />;
  else if (screen.name === "trips") body = <TripsScreen api={api} user={screen.user} onOpen={(trip) => setScreen({ name: "sharing", user: screen.user, trip })} onSignOut={signOut} onSessionEnded={sessionEnded} />;
  else body = <SharingScreen api={api} trip={screen.trip} onBack={() => setScreen({ name: "trips", user: screen.user })} onSessionEnded={sessionEnded} />;

  return (
    <View style={styles.flex}>
      <StatusBar style="dark" />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.canvas },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  title: { color: colors.ink, fontSize: 20, fontWeight: "700" },
  text: { color: colors.muted, fontSize: 15, textAlign: "center" },
});
