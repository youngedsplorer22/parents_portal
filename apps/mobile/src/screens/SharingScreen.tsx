import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError, type Api, type TripView } from "../api/client";
import { LOW_ACCURACY_M, statusOf, STOP_REASON_TEXT } from "../location/policy";
import { loadSharingState, openSettings, permissionStatus, reconcile, sendNow, SharingError, startSharing, stopSharing, type PermissionStatus } from "../location/sharing";
import type { SharingState } from "../location/sharingState";
import { colors, radius } from "../ui/theme";
import { ago, clock } from "../ui/time";

const PERMISSION_TEXT: Record<string, string> = { granted: "Allowed", denied: "Not allowed", undetermined: "Not asked yet" };

/**
 * One trip: Start / Stop, and everything the team lead needs to trust it is working: the status, GPS accuracy, when
 * parents last received a location, the connection, permissions, and why sharing stopped if it stopped on its own.
 * The screen re-checks with the server whenever the app comes back to the front.
 */
export default function SharingScreen({ api, trip: initial, onBack, onSessionEnded }: { api: Api; trip: TripView; onBack: () => void; onSessionEnded: () => void }) {
  const [trip, setTrip] = useState(initial);
  const [state, setState] = useState<SharingState | null>(null);
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; settings?: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const wasOffline = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const s = await reconcile(api);
      setState(s);
      setPerms(await permissionStatus());
      setTrip(await api.trip(initial.enrolmentId));
      if (s.stopReason === "UNAUTHENTICATED") onSessionEnded();
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNAUTHENTICATED") return onSessionEnded();
      setState(await loadSharingState());
    }
  }, [api, initial.enrolmentId, onSessionEnded]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    const sub = AppState.addEventListener("change", (s) => s === "active" && refresh());
    const tick = setInterval(async () => {
      setNow(Date.now());
      setState(await loadSharingState()); // the background task updates it
    }, 15_000);
    const unsubscribe = NetInfo.addEventListener((n) => {
      const isOnline = n.isConnected !== false && n.isInternetReachable !== false;
      setOnline(isOnline);
      // back online while sharing: send a fresh location now rather than waiting for the next cycle
      if (isOnline && wasOffline.current) {
        loadSharingState().then((s) => {
          if (s.enrolmentId) sendNow(api).then(refresh);
        });
      }
      wasOffline.current = !isOnline;
    });
    return () => {
      sub.remove();
      clearInterval(tick);
      unsubscribe();
    };
  }, [api, refresh]);

  const sharingHere = !!state?.enrolmentId && state.enrolmentId === trip.enrolmentId;
  const canShare = trip.teamLead?.canShare === true;
  const status = statusOf({ sharing: sharingHere, lastSentAt: state?.lastSentAt ?? null, online, now });

  async function onStart() {
    setBusy(true);
    setProblem(null);
    try {
      setState(await startSharing(api, trip));
      setTrip(await api.trip(trip.enrolmentId));
    } catch (err) {
      if (err instanceof SharingError) setProblem({ text: err.message, settings: err.code !== "OS_REFUSED" });
      else if (err instanceof ApiError) {
        if (err.code === "UNAUTHENTICATED") return onSessionEnded();
        setProblem({ text: STOP_REASON_TEXT[err.code] ?? (err.code === "NETWORK_ERROR" ? "No connection to the portal. Try again when you're online." : "Couldn't start sharing. Please try again.") });
      } else setProblem({ text: "Couldn't start sharing. Please try again." });
    } finally {
      setBusy(false);
      setPerms(await permissionStatus());
    }
  }
  async function onStop() {
    setBusy(true);
    await stopSharing(api);
    setState(await loadSharingState());
    setTrip(await api.trip(trip.enrolmentId).catch(() => trip));
    setBusy(false);
  }

  const tone = { ok: [colors.successSoft, colors.success], warn: [colors.warnSoft, colors.warn], info: [colors.brandSoft, colors.brandInk], off: ["#f1f4f9", colors.muted] }[status.tone];
  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.page}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}><Text style={styles.backText}>‹ My trips</Text></Pressable>
      <Text style={styles.title}>{trip.trip.title}</Text>
      <Text style={styles.sub}>{trip.trip.school}{trip.trip.branch ? ` · ${trip.trip.branch}` : ""}{trip.trip.destination ? ` · ${trip.trip.destination}` : ""}</Text>

      <View style={[styles.status, { backgroundColor: tone?.[0] }]} accessibilityLiveRegion="polite">
        <Text style={[styles.statusText, { color: tone?.[1] }]}>{status.label}</Text>
      </View>

      {!sharingHere && state?.stopReason && STOP_REASON_TEXT[state.stopReason] ? <Text style={styles.notice} accessibilityRole="alert">{STOP_REASON_TEXT[state.stopReason]}</Text> : null}
      {!canShare ? <Text style={styles.notice}>{trip.trip.status === "active" ? "You can't share for this trip." : "This trip isn't active, so its location can't be shared."}</Text> : null}
      {problem ? (
        <View style={styles.problem}>
          <Text style={styles.problemText} accessibilityRole="alert">{problem.text}</Text>
          {problem.settings ? <Pressable accessibilityRole="button" onPress={openSettings} style={styles.linkButton}><Text style={styles.linkText}>Open Settings</Text></Pressable> : null}
        </View>
      ) : null}

      {sharingHere ? (
        <Pressable accessibilityRole="button" style={[styles.button, styles.stop]} onPress={onStop} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.danger} /> : <Text style={[styles.buttonText, { color: colors.danger }]}>Stop sharing location</Text>}
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" style={[styles.button, (!canShare || busy) && styles.dim]} onPress={onStart} disabled={!canShare || busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Start sharing location</Text>}
        </Pressable>
      )}

      <View style={styles.card}>
        <Fact label="Last update received by parents" value={state?.lastSentAt ? `${clock(state.lastSentAt)} (${ago(now - state.lastSentAt)})` : sharingHere ? "Waiting for the first location" : "—"} />
        <Fact label="GPS accuracy" value={state?.lastAccuracyM != null ? `${state.lastAccuracyM > LOW_ACCURACY_M ? "Approximate, " : ""}within about ${Math.round(state.lastAccuracyM)} m` : "—"} />
        <Fact label="Connection" value={online === null ? "Checking…" : online ? "Online" : "Offline"} />
        {state?.lastError ? <Fact label="Last problem" value={state.lastError === "NETWORK_ERROR" ? "Couldn't reach the portal (will retry)" : state.lastError === "LOCATION_UNAVAILABLE" ? "No GPS fix (will retry)" : "Temporary server problem (will retry)"} /> : null}
        <Fact label="Location permission" value={perms ? `${PERMISSION_TEXT[perms.foreground] ?? perms.foreground} · in background: ${PERMISSION_TEXT[perms.background] ?? perms.background}` : "Checking…"} />
        {perms && !perms.servicesOn ? <Fact label="Location services" value="Off: turn on Location in Settings" /> : null}
        {perms && (perms.background !== "granted" || perms.foreground !== "granted") ? (
          <Pressable accessibilityRole="button" onPress={openSettings} style={styles.linkButton}><Text style={styles.linkText}>Manage location permission</Text></Pressable>
        ) : null}
      </View>

      <Text style={styles.note}>
        While sharing, your phone sends its location about every 5 minutes, also when the screen is locked. Keep the phone charged; if the phone is switched off, the app is force-closed, or there is no signal, parents see the last location marked “Out of date”.
      </Text>
    </ScrollView>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.canvas },
  page: { padding: 16, paddingTop: 56, gap: 12 },
  back: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  backText: { color: colors.brandInk, fontWeight: "600", fontSize: 16 },
  title: { color: colors.ink, fontSize: 24, fontWeight: "700" },
  sub: { color: colors.muted, fontSize: 14 },
  status: { borderRadius: radius, padding: 14 },
  statusText: { fontWeight: "700", fontSize: 15 },
  notice: { backgroundColor: colors.brandSoft, color: colors.brandInk, padding: 12, borderRadius: radius, fontSize: 14, lineHeight: 20 },
  problem: { backgroundColor: colors.dangerSoft, padding: 12, borderRadius: radius, gap: 6 },
  problemText: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  button: { backgroundColor: colors.brand, minHeight: 54, borderRadius: radius, alignItems: "center", justifyContent: "center" },
  stop: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: "#efc4bf" },
  dim: { opacity: 0.5 },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  card: { backgroundColor: colors.surface, borderRadius: radius, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 12 },
  fact: { gap: 2 },
  factLabel: { color: colors.muted, fontSize: 12.5, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
  factValue: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  linkButton: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  linkText: { color: colors.brandInk, fontWeight: "700", fontSize: 15 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
