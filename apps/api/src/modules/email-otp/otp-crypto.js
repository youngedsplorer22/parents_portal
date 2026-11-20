import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const CODE_LENGTH = 6;

export const formatCode = (n) => String(n).padStart(CODE_LENGTH, "0");

/** Uniform 6-digit code from the OS CSPRNG (never Math.random). */
export function generateCode() {
  return formatCode(randomInt(0, 10 ** CODE_LENGTH));
}

// Length-prefixed so no value can be crafted to shift into its neighbour.
const mac = (secret, parts) =>
  createHmac("sha256", secret)
    .update(parts.map((p) => `${p.length}:${p}`).join(""))
    .digest("hex");

/** Keyed hash bound to the OTP row, email and purpose, so a hash cannot be replayed elsewhere. */
export const hashCode = (secret, { otpId, email, purpose, code }) =>
  mac(secret, ["otp-code-v1", otpId, email, purpose, code]);

export function safeEqualHex(a, b) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export const verifyCode = (secret, expectedHash, params) => safeEqualHex(hashCode(secret, params), expectedHash);

/** 256-bit single-use token, URL-safe. */
export const generateToken = () => randomBytes(32).toString("base64url");

export const hashToken = (secret, { token, email, purpose }) =>
  mac(secret, ["verification-token-v1", token, email, purpose]);
