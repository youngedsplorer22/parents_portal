import * as SecureStore from "expo-secure-store";

/**
 * What this phone is sharing, kept across app restarts and readable by the background task (also while the phone is
 * locked, after its first unlock). No position history is kept: only the last send's time and accuracy, for the
 * status screen.
 */
export type SharingState = {
  enrolmentId: string | null; // the trip being shared (the person's own enrolment), or null when not sharing
  tripTitle: string | null;
  startedAt: number | null;
  lastSentAt: number | null;
  lastAccuracyM: number | null;
  lastReadingAt: number | null;
  lastError: string | null; // temporary problem, e.g. NETWORK_ERROR
  stopReason: string | null; // why sharing ended on its own (see STOP_REASON_TEXT)
};
export const EMPTY_STATE: SharingState = { enrolmentId: null, tripTitle: null, startedAt: null, lastSentAt: null, lastAccuracyM: null, lastReadingAt: null, lastError: null, stopReason: null };

export interface StateStore {
  load(): Promise<SharingState>;
  save(s: SharingState): Promise<void>;
}

const KEY = "ye.sharing.v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export const secureStateStore: StateStore = {
  async load() {
    try {
      const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
      return raw ? { ...EMPTY_STATE, ...(JSON.parse(raw) as Partial<SharingState>) } : { ...EMPTY_STATE };
    } catch {
      return { ...EMPTY_STATE };
    }
  },
  async save(s) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(s), OPTIONS);
  },
};
