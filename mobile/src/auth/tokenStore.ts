import * as SecureStore from "expo-secure-store";

/**
 * The sign-in's two tokens, kept only in the phone's secure storage (iOS Keychain / Android Keystore-encrypted
 * storage), never in plain app storage, logs or URLs. "After first unlock, this device only": readable by the
 * background location task while the phone is locked (after it has been unlocked once since starting), never
 * copied to backups or another device.
 */
export type Tokens = { accessToken: string; accessExpiresAt: number; refreshToken: string; refreshExpiresAt: number };

export interface TokenStore {
  load(): Promise<Tokens | null>;
  save(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

const KEY = "ye.session.v1";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const isTokens = (v: unknown): v is Tokens => {
  const t = v as Tokens;
  return !!t && TOKEN.test(t.accessToken) && TOKEN.test(t.refreshToken) && Number.isFinite(t.accessExpiresAt) && Number.isFinite(t.refreshExpiresAt);
};

export const secureTokenStore: TokenStore = {
  async load() {
    try {
      const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return isTokens(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  async save(tokens) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(tokens), OPTIONS);
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  },
};
