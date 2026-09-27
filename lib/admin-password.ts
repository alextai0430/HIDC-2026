import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const keyLength = 64;

export function hashAdminTabPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, keyLength);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyAdminTabPassword(password: string, encoded: string) {
  const [algorithm, saltText, hashText, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText || extra) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (!salt.length || expected.length !== keyLength) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function matchesBootstrapPassword(candidate: string, expected: string) {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
