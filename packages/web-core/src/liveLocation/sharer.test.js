import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocationSharer } from "./sharer.js";

// The team lead's location loop, with fake timers: what is read and sent, and when.

const MIN = 60_000;
const position = (over = {}) => ({ coords: { latitude: 28.6139, longitude: 77.209, accuracy: 20, ...over }, timestamp: Date.now() });
const geoError = (code) => Object.assign(new Error("geo"), { code });
const apiError = (code, details = {}) => Object.assign(new Error(code), { code, details });

/** A fake geolocation whose next answers are queued: a position object, a geoError, or "hang". */
function fakeGeo() {
  const answers = [];
  const geo = {
    calls: 0,
    options: [],
    queue: (...a) => answers.push(...a),
    getCurrentPosition: vi.fn((ok, fail, options) => {
      geo.calls += 1;
      geo.options.push(options);
      const next = answers.length ? answers.shift() : position();
      if (next === "hang") return;
      queueMicrotask(() => (next instanceof Error ? fail(next) : ok(typeof next === "function" ? next() : next)));
    }),
  };
  return geo;
}
const settle = () => vi.advanceTimersByTimeAsync(0);

let online;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T09:00:00.000Z"));
  online = true;
});
afterEach(() => vi.useRealTimers());

function setup(over = {}) {
  const geo = fakeGeo();
  const sent = [];
  const send = vi.fn(async (fix) => {
    sent.push(fix);
  });
  const sharer = createLocationSharer({ geolocation: geo, send, isOnline: () => online, ...over });
  return { geo, sent, send, sharer };
}

describe("the five-minute rhythm", () => {
  it("start reads and sends at once, then exactly once every 5 minutes (not continuously)", async () => {
    const { geo, sent, sharer } = setup();
    sharer.start();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ latitude: 28.6139, longitude: 77.209, accuracy: 20, capturedAt: "2026-10-27T09:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(4 * MIN + 59_000);
    expect(sent).toHaveLength(1); // nothing in between
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * MIN * 10);
    expect(sent).toHaveLength(12); // an hour: 12 updates
    expect(geo.calls).toBe(12);
    expect(geo.options[0]).toMatchObject({ enableHighAccuracy: true, timeout: 30_000, maximumAge: 60_000 });
  });

  it("starting twice never creates a second loop", async () => {
    const { sent, sharer } = setup();
    sharer.start();
    sharer.start();
    await settle();
    sharer.start();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(sent).toHaveLength(4); // 0, 5, 10, 15 minutes
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop clears the timer: nothing more is read or sent", async () => {
    const { geo, sent, sharer } = setup();
    sharer.start();
    await settle();
    sharer.stop();
    expect(sharer.state.phase).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(sent).toHaveLength(1);
    expect(geo.calls).toBe(1);
  });

  it("a reading that finishes after Stop is thrown away (never sent)", async () => {
    const { geo, sent, sharer } = setup();
    let deliver;
    geo.queue("hang");
    geo.getCurrentPosition.mockImplementationOnce((ok) => {
      geo.calls += 1;
      deliver = ok;
    });
    sharer.start();
    sharer.stop();
    deliver(position());
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("after a long background pause, wake() sends at once if an update is overdue; otherwise it waits", async () => {
    const { sent, sharer } = setup();
    sharer.start();
    await settle();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    sharer.wake();
    await settle();
    expect(sent).toHaveLength(1); // not due yet
    vi.setSystemTime(Date.now() + 7 * MIN); // the timer was frozen while the tab was hidden
    sharer.wake();
    await settle();
    expect(sent).toHaveLength(2);
  });
});

describe("problems with the phone's location", () => {
  it("permission denied stops sharing and says why (it can't fix itself)", async () => {
    const { geo, sent, sharer } = setup();
    geo.queue(geoError(1));
    sharer.start();
    await settle();
    expect(sharer.state).toMatchObject({ phase: "stopped", stopReason: "permission_denied" });
    expect(sent).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no GPS fix or a timeout is shown as a warning and retried after 1 minute; the loop carries on", async () => {
    const { geo, sent, sharer } = setup();
    geo.queue(geoError(2), geoError(3));
    sharer.start();
    await settle();
    expect(sharer.state).toMatchObject({ phase: "waiting", warning: "unavailable" });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sharer.state.warning).toBe("timeout");
    await vi.advanceTimersByTimeAsync(MIN);
    expect(sent).toHaveLength(1);
    expect(sharer.state.warning).toBe(null);
  });

  it("a low-accuracy reading is still sent, flagged as approximate", async () => {
    const { geo, sent, sharer } = setup();
    geo.queue(position({ accuracy: 1800 }));
    sharer.start();
    await settle();
    expect(sent[0].accuracy).toBe(1800);
    expect(sharer.state.warning).toBe("low_accuracy");
  });

  it("a phone clock far off uses the time the reading arrived instead", async () => {
    const { geo, sent, sharer } = setup();
    geo.queue({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: Date.parse("2020-01-01T00:00:00Z") });
    sharer.start();
    await settle();
    expect(sent[0].capturedAt).toBe("2026-10-27T09:00:00.000Z");
  });
});

describe("problems sending", () => {
  it("offline: nothing is read or sent; retried every minute; back online -> sent immediately via wake()", async () => {
    const { geo, sent, sharer } = setup();
    online = false;
    sharer.start();
    await settle();
    expect(sharer.state.warning).toBe("offline");
    expect(geo.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    online = true;
    vi.setSystemTime(Date.now() + 40_000);
    sharer.wake();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sharer.state.warning).toBe(null);
  });

  it("a failed upload is retried after 1 minute with a fresh reading (no duplicate of the old one)", async () => {
    const { send, sharer } = setup();
    send.mockRejectedValueOnce(apiError("NETWORK_ERROR"));
    sharer.start();
    await settle();
    expect(sharer.state.warning).toBe("offline");
    await vi.advanceTimersByTimeAsync(MIN);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].capturedAt).toBe("2026-10-27T09:01:00.000Z"); // a new reading, not the failed one again
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(send).toHaveBeenCalledTimes(3); // back to every 5 minutes
  });

  it("the server saying sharing is over (trip ended, team lead changed, signed out) stops the loop", async () => {
    for (const [code, reason] of [["TRIP_NOT_ACTIVE", "server_stopped"], ["NOT_SHARING", "server_stopped"], ["NOT_TEAM_LEAD", "server_stopped"], ["UNAUTHENTICATED", "signed_out"]]) {
      const { send, sharer } = setup();
      send.mockRejectedValueOnce(apiError(code));
      sharer.start();
      await settle();
      expect(sharer.state, code).toMatchObject({ phase: "stopped", stopReason: reason });
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(send, code).toHaveBeenCalledTimes(1);
    }
  });

  it("'too frequent' waits as long as the server asks, then carries on", async () => {
    const { send, sharer } = setup();
    send.mockRejectedValueOnce(apiError("TOO_FREQUENT", { retryAfterSeconds: 30 }));
    sharer.start();
    await settle();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("an upload still in progress is never overlapped by another one", async () => {
    const { send, sharer } = setup();
    let release;
    send.mockImplementationOnce(() => new Promise((r) => (release = r)));
    sharer.start();
    await settle();
    sharer.wake();
    vi.setSystemTime(Date.now() + 10 * MIN);
    sharer.wake();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
  });
});
