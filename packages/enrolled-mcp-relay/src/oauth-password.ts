import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16_384;
const R = 8;
const P = 1;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 32, { N, r: R, p: P }).toString("base64url");
  return `scrypt$${N}$${R}$${P}$${salt}$urlsafe$${hash}`;
}

export function isPasswordHashFormat(value: string): boolean {
  const parts = value.trim().split("$");
  return parts.length === 7 && parts[0] === "scrypt" && parts[5] === "urlsafe";
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  try {
    const parts = encodedHash.trim().split("$");
    const salt = parts[4];
    const digest = parts[6];
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[5] !== "urlsafe" || !salt || !digest) {
      return false;
    }
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const expected = Buffer.from(digest, "base64url");
    const computed = scryptSync(password, salt, expected.length, { N: n, r, p });
    return expected.length === computed.length && timingSafeEqual(computed, expected);
  } catch {
    return false;
  }
}
