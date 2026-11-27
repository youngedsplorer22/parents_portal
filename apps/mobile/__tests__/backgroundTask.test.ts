import { ApiError } from "../src/api/client";
import { handleLocations } from "../src/location/backgroundTask";
import { EMPTY_STATE, type SharingState, type StateStore } from "../src/location/sharingState";

const E = "00000000-0000-4000-9000-000000000001";
const NOW = Date.parse("2026-10-27T10:00:00Z");
const reading = (ageMs = 30_000, accuracy = 15) => ({ coords: { latitude: 22.57, longitude: 88.36, accuracy }, timestamp: NOW - ageMs });
function setup(initial: Partial<SharingState> = {}, send: jest.Mock = jest.fn(async () => ({}))) {
  const store = { value: { ...EMPTY_STATE, enrolmentId: E, ...initial } as SharingState };
  const state: StateStore = { load: async () => ({ ...store.value }), save: async (s) => void (store.value = s) };
  const stopUpdates = jest.fn(async () => {});
  const deps = { api: { sendLocation: send }, state, stopUpdates, now: () => NOW };
  return { store, stopUpdates, send, run: (readings = [reading()], error: { message?: string } | null = null) => handleLocations(deps, { readings, error }) };
}

describe("the background location task", () => {
  it("sends the newest reading, with its real time, and records the success", async () => {
    const t = setup();
    expect(await t.run([reading(120_000), reading(30_000)])).toBe("sent");
    expect(t.send).toHaveBeenCalledWith(E, { latitude: 22.57, longitude: 88.36, accuracy: 15, capturedAt: new Date(NOW - 30_000).toISOString() });
    expect(t.store.value).toMatchObject({ lastSentAt: NOW, lastAccuracyM: 15, lastError: null });
  });

  it("doesn't send more often than every 4.5 minutes (the OS may deliver readings more often)", async () => {
    const t = setup({ lastSentAt: NOW - 60_000 });
    expect(await t.run()).toBe("skipped");
    expect(t.send).not.toHaveBeenCalled();
    expect(t.store.value.lastAccuracyM).toBe(15); // the screen still shows the latest accuracy
  });

  it("when not sharing, it switches the OS updates off and sends nothing", async () => {
    const t = setup({ enrolmentId: null });
    expect(await t.run()).toBe("idle");
    expect(t.stopUpdates).toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
  });

  it("offline: remembers the problem and keeps sharing (the next reading tries again)", async () => {
    const t = setup({}, jest.fn(async () => { throw new ApiError("NETWORK_ERROR"); }));
    expect(await t.run()).toBe("failed");
    expect(t.store.value).toMatchObject({ enrolmentId: E, lastError: "NETWORK_ERROR", lastSentAt: null });
    expect(t.stopUpdates).not.toHaveBeenCalled();
  });

  it.each([["UNAUTHENTICATED"], ["NOT_TEAM_LEAD"], ["TRIP_NOT_ACTIVE"], ["NOT_SHARING"]])("server says %s: stops the OS updates and remembers why", async (code) => {
    const t = setup({}, jest.fn(async () => { throw new ApiError(code, 409); }));
    expect(await t.run()).toBe("stopped");
    expect(t.stopUpdates).toHaveBeenCalled();
    expect(t.store.value).toMatchObject({ enrolmentId: null, stopReason: code });
  });

  it("a reading too old for the server (e.g. delivered late after a long offline spell) is not sent", async () => {
    const t = setup();
    expect(await t.run([reading(20 * 60_000)])).toBe("skipped");
    expect(t.send).not.toHaveBeenCalled();
  });

  it("a GPS error is recorded and nothing is sent; a refused reading is skipped without stopping", async () => {
    const t = setup();
    expect(await t.run([], { message: "kCLErrorLocationUnknown" })).toBe("failed");
    expect(t.store.value.lastError).toBe("LOCATION_UNAVAILABLE");
    const t2 = setup({}, jest.fn(async () => { throw new ApiError("INVALID_LOCATION", 400); }));
    expect(await t2.run()).toBe("skipped");
    expect(t2.store.value.enrolmentId).toBe(E);
  });
});
