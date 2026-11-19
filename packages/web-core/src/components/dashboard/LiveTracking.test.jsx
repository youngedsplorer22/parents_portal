import { act, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingFlow from "../onboarding/OnboardingFlow.jsx";
import { FAKE_REFERENCE, createFakeBackend } from "../../test/fakeBackend.js";
import { storageIsEmpty } from "../../test/helpers.js";

// Dashboard > Live Tracking, as parents and the team lead see it. The map itself (Leaflet) is replaced by a stand-in
// that shows what it was given; the real map is checked in a real browser.
vi.mock("../../liveLocation/LiveMap.jsx", () => ({
  default: ({ location, stale }) => <div data-testid="map" data-lat={location.latitude} data-lng={location.longitude} data-stale={String(stale)} />,
}));

// The dashboard and the lazily loaded map can take a few seconds to appear when the whole suite runs at once.
configure({ asyncUtilTimeout: 5000 });

const TRIP = { school: "GV School", branch: "Kolkata", title: "Jaipur 2027", destination: "Jaipur", tourType: "domestic", academicYear: "2026-27", paymentMode: "none" };
const ENROLMENT = "00000000-0000-4000-9000-000000000001";
const ANSWERS = { fullName: "Asha Rao", gender: "Female", classSection: "4 - B", dateOfBirth: "2016-05-04", nomineeName: "B Vijaya", nomineeRelation: "Mother", mealPreference: "Veg", allergy: "Peanuts", phone: "9876543210", remark: "" };
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

let user;
let geo;
let secure;
beforeEach(() => {
  user = userEvent.setup();
  window.location.hash = "#live-tracking";
  geo = { getCurrentPosition: vi.fn((ok) => queueMicrotask(() => ok({ coords: { latitude: 26.9124, longitude: 75.7873, accuracy: 15 }, timestamp: Date.now() }))) };
  Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
  secure = true;
  Object.defineProperty(window, "isSecureContext", { get: () => secure, configurable: true });
});
afterEach(() => {
  window.location.hash = "";
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

function submitted(live = {}) {
  const be = createFakeBackend({ signedIn: true });
  Object.assign(be.state, {
    trip: TRIP,
    currentId: ENROLMENT,
    form: { tourType: "domestic", role: "student", status: "submitted", data: ANSWERS, currentSection: "review", version: 6, updatedAt: minutesAgo(60), submittedAt: minutesAgo(60), reference: FAKE_REFERENCE, acknowledgement: { declarationVersion: "2026-10-v1", acceptedAt: minutesAgo(60), signatureName: "Meera Rao" } },
  });
  Object.assign(be.state.live, live);
  return be;
}
const open = (be, props = {}) => render(<OnboardingFlow user={be.state.user} onSignedOut={vi.fn()} enrolmentId={ENROLMENT} {...props} />);
const liveCalls = (be, key = "GET /api/live-location") => be.calls().filter((c) => c.key === key);
const section = () => document.querySelector(".dashboard-main");

describe("parents", () => {
  it("before sharing starts: a clear message, no map, no controls, and parents are never asked for their own location", async () => {
    const be = submitted();
    open(be);
    expect(await screen.findByText(/hasn't started sharing their location yet/)).toBeInTheDocument();
    expect(within(section()).getByText("Not sharing")).toBeInTheDocument();
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start Live Location/ })).not.toBeInTheDocument();
    expect(within(section()).getByText(/GV School · Kolkata/)).toBeInTheDocument(); // which trip this is
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(liveCalls(be)[0].url).toBe(`/api/live-location?enrolment=${ENROLMENT}`); // only their own enrolment is named
  });

  it("live: the map at the shared position, the real 'Last updated' time and how long ago, accuracy, and an OpenStreetMap link", async () => {
    const capturedAt = minutesAgo(2);
    open(submitted({ state: "live", location: { latitude: 26.9124, longitude: 75.7873, accuracyM: 15, capturedAt, receivedAt: capturedAt } }));
    const map = await screen.findByTestId("map");
    expect(map).toHaveAttribute("data-lat", "26.9124");
    expect(map).toHaveAttribute("data-stale", "false");
    expect(within(section()).getByText("Live")).toBeInTheDocument();
    const time = section().querySelector("time");
    expect(time).toHaveAttribute("datetime", capturedAt);
    expect(within(section()).getByText("(2 minutes ago)")).toBeInTheDocument();
    expect(within(section()).getByText("Within about 15 m")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open in OpenStreetMap/ })).toHaveAttribute("href", expect.stringContaining("mlat=26.9124&mlon=75.7873"));
  });

  it("stale: the last known position, greyed, with an explicit warning that it is not live", async () => {
    const capturedAt = minutesAgo(20);
    open(submitted({ state: "stale", location: { latitude: 26.9, longitude: 75.8, accuracyM: 30, capturedAt, receivedAt: capturedAt } }));
    expect(await screen.findByTestId("map")).toHaveAttribute("data-stale", "true");
    expect(within(section()).getByText("Out of date")).toBeInTheDocument();
    expect(within(section()).getByText(/last known position, not their live position/)).toBeInTheDocument();
    expect(within(section()).queryByText("Live")).not.toBeInTheDocument();
  });

  it("a position that has aged past the limit since the last refresh is shown as out of date, even if the server said live", async () => {
    const capturedAt = minutesAgo(13);
    open(submitted({ state: "live", location: { latitude: 26.9, longitude: 75.8, accuracyM: 10, capturedAt, receivedAt: capturedAt } }));
    expect(await screen.findByTestId("map")).toHaveAttribute("data-stale", "true");
    expect(within(section()).getByText("Out of date")).toBeInTheDocument();
  });

  it("stopped and trip ended: a message and no map (an old position is never shown)", async () => {
    const v = open(submitted({ state: "stopped" }));
    expect(await screen.findByText(/has stopped sharing their location/)).toBeInTheDocument();
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
    v.unmount();
    open(submitted({ tripActive: false, state: "live", location: { latitude: 1, longitude: 2, accuracyM: 5, capturedAt: minutesAgo(1) } }));
    expect(await screen.findByText(/This trip has ended/)).toBeInTheDocument();
    expect(screen.queryByTestId("map")).not.toBeInTheDocument();
  });

  it("refreshes on its interval while visible; stops while the page is hidden; refreshes at once on return", async () => {
    const be = submitted();
    open(be, { liveRefreshMs: 1500 });
    await screen.findByText(/hasn't started sharing/);
    await waitFor(() => expect(liveCalls(be).length).toBe(2), { timeout: 3000 });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    const hiddenAt = liveCalls(be).length;
    await new Promise((r) => setTimeout(r, 2000));
    expect(liveCalls(be).length).toBe(hiddenAt); // nothing while hidden
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(liveCalls(be).length).toBe(hiddenAt + 1));
  });

  it("a later position appears after the next refresh, replacing the old one", async () => {
    const be = submitted({ state: "live", location: { latitude: 26.9, longitude: 75.8, accuracyM: 10, capturedAt: minutesAgo(6) } });
    open(be, { liveRefreshMs: 1200 });
    expect(await screen.findByTestId("map")).toHaveAttribute("data-lat", "26.9");
    be.state.live.location = { latitude: 27.0, longitude: 75.9, accuracyM: 10, capturedAt: minutesAgo(1) };
    await waitFor(() => expect(screen.getByTestId("map")).toHaveAttribute("data-lat", "27"), { timeout: 3000 });
  });
});

describe("the team lead", () => {
  it("Start asks for the location once, sends it, and shows Sharing with Stop; the map then shows it", async () => {
    const be = submitted({ teamLead: { canShare: true } });
    open(be);
    await user.click(await screen.findByRole("button", { name: /Start Live Location/ }));
    await waitFor(() => expect(be.state.liveSends).toHaveLength(1));
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(be.state.liveSends[0]).toMatchObject({ enrolmentId: ENROLMENT, latitude: 26.9124, longitude: 75.7873, accuracy: 15 });
    expect(Object.keys(be.state.liveSends[0]).sort()).toEqual(["accuracy", "capturedAt", "enrolmentId", "latitude", "longitude"]); // no trip id or identity is ever sent
    expect(await screen.findByRole("button", { name: /Stop Live Location/ })).toBeInTheDocument();
    expect(await screen.findByTestId("map")).toHaveAttribute("data-lat", "26.9124");
    expect(screen.getByText(/Keep this page open with the screen on/)).toBeInTheDocument();
    expect(storageIsEmpty()).toBe(true); // no location kept in the browser
  });

  it("Stop tells the server (which wipes the position) and no further location is read", async () => {
    const be = submitted({ teamLead: { canShare: true } });
    open(be);
    await user.click(await screen.findByRole("button", { name: /Start Live Location/ }));
    await user.click(await screen.findByRole("button", { name: /Stop Live Location/ }));
    await waitFor(() => expect(liveCalls(be, "POST /api/live-location/stop")).toHaveLength(1));
    expect(await screen.findByText(/has stopped sharing their location/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Live Location/ })).toBeInTheDocument();
    const reads = geo.getCurrentPosition.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(geo.getCurrentPosition.mock.calls.length).toBe(reads);
  });

  it("location permission refused: sharing stops with an explanation of how to allow it", async () => {
    geo.getCurrentPosition.mockImplementation((ok, fail) => queueMicrotask(() => fail({ code: 1, message: "denied" })));
    const be = submitted({ teamLead: { canShare: true } });
    open(be);
    await user.click(await screen.findByRole("button", { name: /Start Live Location/ }));
    expect(await screen.findByText(/Location permission was refused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Live Location/ })).toBeInTheDocument();
    await waitFor(() => expect(liveCalls(be, "POST /api/live-location/stop")).toHaveLength(1)); // the server is told too
    expect(be.state.liveSends).toHaveLength(0);
  });

  it("no GPS fix: a warning and sharing carries on (it tries again)", async () => {
    geo.getCurrentPosition.mockImplementationOnce((ok, fail) => queueMicrotask(() => fail({ code: 2, message: "unavailable" })));
    const be = submitted({ teamLead: { canShare: true } });
    open(be);
    await user.click(await screen.findByRole("button", { name: /Start Live Location/ }));
    expect(await screen.findByText(/couldn't find its location just now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop Live Location/ })).toBeInTheDocument();
  });

  it("without a secure (https) address the Start button is disabled and says why", async () => {
    secure = false;
    open(submitted({ teamLead: { canShare: true } }));
    expect(await screen.findByText(/needs a secure \(https:\/\/\) address/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Live Location/ })).toBeDisabled();
  });

  it("when the trip has ended, sharing can't start", async () => {
    open(submitted({ teamLead: { canShare: true }, tripActive: false }));
    expect(await screen.findByText(/only possible while the trip is active/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start Live Location/ })).toBeDisabled();
  });

  it("sharing keeps going while the team lead looks at other dashboard sections", async () => {
    const be = submitted({ teamLead: { canShare: true } });
    open(be);
    await user.click(await screen.findByRole("button", { name: /Start Live Location/ }));
    await screen.findByRole("button", { name: /Stop Live Location/ });
    await user.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("link", { name: "Itinerary" }));
    await user.click(within(screen.getByRole("navigation", { name: "Dashboard sections" })).getByRole("link", { name: "Live Tracking" }));
    expect(await screen.findByRole("button", { name: /Stop Live Location/ })).toBeInTheDocument();
    expect(liveCalls(be, "POST /api/live-location/stop")).toHaveLength(0);
  });

  it("logging out stops sharing first (the server wipes the position), then signs out", async () => {
    const be = submitted({ teamLead: { canShare: true } });
    open(be);
    await user.click(await screen.findByRole("button", { name: /Start Live Location/ }));
    await screen.findByRole("button", { name: /Stop Live Location/ });
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    await waitFor(() => expect(be.calls().some((c) => c.key === "POST /api/auth/logout")).toBe(true));
    const keys = be.calls().map((c) => c.key);
    expect(keys.indexOf("POST /api/live-location/stop")).toBeGreaterThan(-1);
    expect(keys.indexOf("POST /api/live-location/stop")).toBeLessThan(keys.indexOf("POST /api/auth/logout"));
  });

  it("a parent who isn't the team lead never sees sharing controls", async () => {
    open(submitted({ teamLead: null, state: "waiting" }));
    expect(await screen.findByText(/Waiting for the first location/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start Live Location|Stop Live Location/ })).not.toBeInTheDocument();
  });
});
