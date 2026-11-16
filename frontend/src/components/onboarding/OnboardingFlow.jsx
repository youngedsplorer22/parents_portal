import { LoaderCircle, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { logout } from "../../api/authApi.js";
import { stopLiveSharing } from "../../liveLocation/liveSharing.js";
import { enrolInTrip, enrolmentErrorMessage, resumeTarget } from "../../api/enrolmentApi.js";
import { loadOnboarding, onboardingErrorMessage, saveDraft } from "../../api/onboardingApi.js";
import PortalHeader from "../PortalHeader.jsx";
import OnboardingWizard from "./OnboardingWizard.jsx";
import ParentDashboard from "../dashboard/ParentDashboard.jsx";
import { NoTripYet, SeveralRegistrations } from "./ResumeNotices.jsx";
import TourPicker from "./TourPicker.jsx";

/**
 * Everything after sign-in: loads the saved state from the server (so a returning
 * user resumes exactly where they left off), then shows the tour picker, the
 * wizard, or the submitted registration's confirmation and details.
 *
 * Which registration, always from the server's records, never "the newest" by default:
 *  - from a trip's public page (join): THAT trip's registration (joining is a no-op if the parent already has it), so
 *    a draft resumes at its saved section and a submitted one opens its confirmation, with no duplicate;
 *  - /registrations/<id> (chosen): that one, checked against the session by the server;
 *  - otherwise (plain homepage) the server decides: no registration -> ask them to open their school's trip page;
 *    exactly one -> open it; several -> a short message asking them to open their school's trip link (no list, no guess).
 */
/** The router's navigate when this page is inside one (it always is in the app); null in a bare unit test. */
function useOptionalNavigate() {
  const inRouter = useInRouterContext(); // fixed for the life of the component, so the hook order never changes
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return inRouter ? useNavigate() : null;
}

export default function OnboardingFlow({ user, onSignedOut, join = null, enrolmentId: chosen = null, existingOnly = false, autosaveDelayMs = 800, pdfPollMs, pdfMaxPolls, liveRefreshMs }) {
  const navigate = useOptionalNavigate();
  const [state, setState] = useState({ phase: "loading" }); // loading | error | ready
  const [generation, setGeneration] = useState(0); // bumps to remount the wizard with fresh server data
  const [logoutError, setLogoutError] = useState("");
  const [notice, setNotice] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const flushRef = useRef(async () => true);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // On a trip's public page the parent joins THAT trip first (a new parent was already joined by
    // registering; enrolling again is a no-op on the server). The trip comes from the address bar, so this
    // repeats safely after a refresh. A refused trip is explained and never swapped for another trip.
    const joined = join
      ? enrolInTrip(join.address, { signal: controller.signal }).then(
          (r) => {
            setNotice("");
            return r.enrolmentId; // this trip's registration: the form shown is THIS one, not just the newest
          },
          (err) => {
            if (err?.name === "AbortError" || err?.code === "UNAUTHENTICATED") throw err;
            if (err?.code === "NETWORK_ERROR") throw err; // "Try again" repeats it
            // Refused (closed or no longer public): say so, and fall back to the server's choice among the parent's
            // OWN registrations; never another trip, never simply the newest.
            setNotice(enrolmentErrorMessage(err));
            return resume();
          },
        )
      : chosen
        ? Promise.resolve(chosen)
        : resume();
    function resume() {
      return resumeTarget({ signal: controller.signal }).then((r) =>
        r.status === "one" ? r.enrolmentId : { stop: { phase: r.status === "none" ? "no-trip" : "several" } },
      );
    }
    joined
      .then((picked) => {
        if (picked?.stop) return picked;
        return loadOnboarding({ signal: controller.signal, enrolmentId: picked });
      })
      .then((data) => {
        if (data.stop) {
          setState(data.stop);
          return;
        }
        // Opened by address (/registrations/legacy) but there is nothing there: don't offer to start a trip-less form.
        if (existingOnly && !data.form && !data.trip) {
          setState({ phase: "no-trip" });
          return;
        }
        // Remember exactly which registration this is, so every save and the submit go to it.
        setState({ phase: "ready", ...data, enrolmentId: data.enrolmentId ?? (chosen === "legacy" ? "legacy" : null) });
        setGeneration((g) => g + 1);
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (err?.code === "UNAUTHENTICATED") onSignedOut("Your session has ended. Please log in again.");
        else if (err?.code === "NETWORK_ERROR") {
          // Nothing has loaded yet, so nothing can be "unsaved": say what happened and offer Try again.
          setState({ phase: "error", message: join ? enrolmentErrorMessage(err) : "Can't reach the server. Check your connection and try again." });
        } else setState({ phase: "error", message: onboardingErrorMessage(err) });
      });
    return () => controller.abort();
  }, [onSignedOut, reloadKey, join, chosen, existingOnly]);

  // Reload from the server (retry, or after a conflict): show the loading state, then fetch.
  const reload = () => {
    setState({ phase: "loading" });
    setReloadKey((k) => k + 1);
  };

  /**
   * The server has committed the submission. Go to the dashboard at its own address, and read the saved registration back
   * from the server (rather than trusting the form on the screen). Nothing is downloaded and nothing is sent again.
   */
  const goToDashboard = () => {
    reload();
    navigate?.(`/parent/registrations/${encodeURIComponent(state.enrolmentId ?? "legacy")}`, { replace: true });
  };

  const sessionEnded = useCallback(() => {
    stopLiveSharing({ notifyServer: false }).catch(() => {}); // the sign-in is over; the server already treats sharing as stopped
    onSignedOut("Your session has ended. Please log in again.");
  }, [onSignedOut]);

  const choose = async (tourType) => {
    const def = state.definitions[tourType];
    const form = await saveDraft({ tourType, data: {}, currentSection: def.sections[0].id, version: null, enrolmentId: state.enrolmentId ?? undefined });
    setState((s) => ({ ...s, form }));
    setGeneration((g) => g + 1);
  };

  const signOut = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await flushRef.current(); // don't lose pending edits
      await stopLiveSharing({ notifyServer: true }).catch(() => {}); // a team lead signing out stops sharing (and wipes the position)
      await logout();
      onSignedOut();
    } catch {
      setLogoutError("We couldn't log you out. Check your connection and try again.");
      setLoggingOut(false);
    }
  };

  let body;
  if (state.phase === "loading") {
    body = (
      <p className="onboarding-loading" role="status">
        <LoaderCircle size={18} className="spin" /> Loading your form…
      </p>
    );
  } else if (state.phase === "error") {
    body = (
      <div className="status-message error" role="alert">
        <span>{state.message}</span>
        <button type="button" className="text-button" onClick={reload}>Try again</button>
      </div>
    );
  } else if (state.phase === "no-trip") {
    body = <NoTripYet />;
  } else if (state.phase === "several") {
    body = <SeveralRegistrations />;
  } else if (!state.form) {
    body = <TourPicker role={state.role} definitions={state.definitions} trip={state.trip} onChoose={choose} />;
  } else if (state.form.status === "submitted") {
    body = <ParentDashboard data={state} pdfPollMs={pdfPollMs} pdfMaxPolls={pdfMaxPolls} onSessionEnded={sessionEnded} liveRefreshMs={liveRefreshMs} />;
  } else {
    body = (
      <OnboardingWizard
        key={generation}
        definition={state.definitions[state.form.tourType]}
        form={state.form}
        autosaveDelayMs={autosaveDelayMs}
        flushRef={flushRef}
        onSubmitted={goToDashboard}
        onReload={reload}
        onUnauthenticated={sessionEnded}
        enrolmentId={state.enrolmentId}
        destination={state.trip?.destination ?? ""}
        declaration={state.declaration}
      />
    );
  }

  return (
    <div className={`onboarding-shell${state.phase === "ready" && state.form?.status === "submitted" ? " dashboard-shell" : ""}`}>
      <PortalHeader schoolName={state.trip?.school ?? ""} schoolLogo={state.trip?.schoolLogo ?? null}>
        <span className="onboarding-hello">Hi, {user.firstName}</span>
        <button type="button" className="text-button" onClick={signOut} disabled={loggingOut}>
          <LogOut size={15} aria-hidden="true" /> Log out
        </button>
      </PortalHeader>
      {notice && <div className="status-message info" role="status"><span>{notice}</span></div>}
      {logoutError && <div className="status-message error" role="alert"><span>{logoutError}</span></div>}
      {body}
    </div>
  );
}
