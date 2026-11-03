import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { ApiError, type Api, type TripView, type User } from "../api/client";
import { colors, radius } from "../ui/theme";

const STATE_LABEL: Record<string, string> = { not_started: "Not sharing", waiting: "Starting", live: "Live", stale: "Out of date", stopped: "Sharing ended", ended: "Trip ended" };

/** Only the trips the Young Edsplorer team made this person the team lead of (the server decides). */
export default function TripsScreen({ api, user, onOpen, onSignOut, onSessionEnded }: {
  api: Api; user: User; onOpen: (t: TripView) => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const [trips, setTrips] = useState<TripView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTrips(await api.trips());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNAUTHENTICATED") return onSessionEnded();
      setError(err instanceof ApiError && err.code === "NETWORK_ERROR" ? "No connection. Pull down to try again." : "Couldn't load your trips. Pull down to try again.");
    }
  }, [api, onSessionEnded]);
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  return (
    <View style={styles.flex}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>My trips</Text>
          <Text style={styles.sub}>{user.firstName} {user.lastName}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={onSignOut} style={styles.signOut}><Text style={styles.signOutText}>Sign out</Text></Pressable>
      </View>
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      {trips === null && !error ? <ActivityIndicator style={{ marginTop: 40 }} /> : null}
      <FlatList
        data={trips ?? []}
        keyExtractor={(t) => t.enrolmentId}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={trips ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No trips yet</Text>
            <Text style={styles.emptyText}>You’ll see a trip here once the Young Edsplorer team has chosen you as its team lead in the portal. Registering as a Team Leader is not enough on its own.</Text>
          </View>
        ) : null}
        renderItem={({ item }) => {
          const active = item.trip.status === "active";
          return (
            <Pressable accessibilityRole="button" accessibilityHint="Opens location sharing for this trip" style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]} onPress={() => onOpen(item)}>
              <Text style={styles.cardTitle}>{item.trip.title}</Text>
              <Text style={styles.cardSub}>{item.trip.school}{item.trip.branch ? ` · ${item.trip.branch}` : ""}{item.trip.destination ? ` · ${item.trip.destination}` : ""}</Text>
              <View style={styles.row}>
                <Text style={[styles.pill, active ? styles.pillOn : styles.pillOff]}>{active ? "Active trip" : `Trip ${item.trip.status}`}</Text>
                <Text style={styles.pill}>{STATE_LABEL[item.state] ?? item.state}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.canvas },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 64, paddingBottom: 12, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line },
  title: { color: colors.ink, fontSize: 24, fontWeight: "700" },
  sub: { color: colors.muted, fontSize: 14, marginTop: 2 },
  signOut: { paddingHorizontal: 12, minHeight: 44, justifyContent: "center" },
  signOutText: { color: colors.brandInk, fontWeight: "600", fontSize: 15 },
  error: { margin: 16, marginBottom: 0, color: colors.danger, backgroundColor: colors.dangerSoft, padding: 12, borderRadius: radius },
  empty: { backgroundColor: colors.surface, borderRadius: radius, padding: 18, borderWidth: 1, borderColor: colors.line },
  emptyTitle: { color: colors.ink, fontWeight: "700", fontSize: 17 },
  emptyText: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 },
  card: { backgroundColor: colors.surface, borderRadius: radius, padding: 16, borderWidth: 1, borderColor: colors.line },
  cardTitle: { color: colors.ink, fontWeight: "700", fontSize: 17 },
  cardSub: { color: colors.muted, fontSize: 14, marginTop: 4 },
  row: { flexDirection: "row", gap: 8, marginTop: 10, flexWrap: "wrap" },
  pill: { fontSize: 12.5, fontWeight: "700", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: "hidden", backgroundColor: "#f1f4f9", color: colors.muted },
  pillOn: { backgroundColor: colors.successSoft, color: colors.success },
  pillOff: { backgroundColor: "#f1f4f9", color: colors.muted },
});
