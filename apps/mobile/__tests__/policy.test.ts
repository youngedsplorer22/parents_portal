import { classify, MIN_SEND_GAP_MS, pickLatest, sendDue, statusOf, toFix } from "../src/location/policy";

const r = (lat: number, lng: number, timestamp: number, accuracy: number | null = 20) => ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp });

describe("location rules", () => {
  it("picks the newest valid reading of a batch; drops impossible ones (0,0, out of range, wild accuracy)", () => {
    expect(pickLatest([r(22.5, 88.3, 100), r(22.6, 88.4, 300), r(22.7, 88.5, 200)])?.timestamp).toBe(300);
    expect(pickLatest([r(0, 0, 999), r(91, 10, 998), r(10, 181, 997), r(22.5, 88.3, 1, 50_000), r(22.5, 88.3, 5)])?.timestamp).toBe(5);
    expect(pickLatest([])).toBeNull();
  });
  it("sends at most every 4.5 minutes", () => {
    expect(sendDue(null, 0)).toBe(true);
    expect(sendDue(0, MIN_SEND_GAP_MS - 1)).toBe(false);
    expect(sendDue(0, MIN_SEND_GAP_MS)).toBe(true);
  });
  it("sends the reading's real capture time, and never one too old for the server or from the future", () => {
    const now = Date.parse("2026-10-27T10:00:00Z");
    expect(toFix(r(22.5, 88.3, now - 60_000, 12.345), now)).toEqual({ latitude: 22.5, longitude: 88.3, accuracy: 12.3, capturedAt: "2026-10-27T09:59:00.000Z" });
    expect(toFix(r(22.5, 88.3, now - 15 * 60_000), now)).toBeNull();
    expect(toFix(r(22.5, 88.3, now + 5 * 60_000), now)).toBeNull();
    expect(toFix(r(22.5, 88.3, now, null), now)?.accuracy).toBeNull();
  });
  it("knows which server answers end sharing, which to retry and which to skip", () => {
    for (const c of ["UNAUTHENTICATED", "NOT_TEAM_LEAD", "TRIP_NOT_ACTIVE", "NOT_SHARING", "NOT_FOUND"]) expect(classify(c)).toBe("stop");
    for (const c of ["NETWORK_ERROR", "SERVER_ERROR", "RATE_LIMITED", "TOO_FREQUENT"]) expect(classify(c)).toBe("retry");
    expect(classify("INVALID_LOCATION")).toBe("drop");
  });
  it("status: not sharing, starting, sharing, out of date (12 min), offline", () => {
    expect(statusOf({ sharing: false, lastSentAt: null, online: true, now: 0 }).label).toBe("Not sharing");
    expect(statusOf({ sharing: true, lastSentAt: null, online: true, now: 0 }).tone).toBe("info");
    expect(statusOf({ sharing: true, lastSentAt: 0, online: true, now: 5 * 60_000 }).tone).toBe("ok");
    expect(statusOf({ sharing: true, lastSentAt: 0, online: true, now: 13 * 60_000 }).tone).toBe("warn");
    expect(statusOf({ sharing: true, lastSentAt: 0, online: false, now: 60_000 }).label).toMatch(/No internet/);
  });
});
