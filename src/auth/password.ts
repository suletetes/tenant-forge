import argon2 from "argon2";
import { randomBytes } from "node:crypto";

/**
 * Password hashing (R1.6). Argon2id with sensible defaults. Plaintext is never stored or logged.
 */
export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  return argon2.verify(hash, plaintext);
}

/**
 * A real Argon2id hash of a random secret, computed once and cached. Used for a "dummy" verify
 * when a login email doesn't exist, so timing is uniform whether or not the user exists —
 * preventing user enumeration via timing (R3, mirrors R22.1's anti-enumeration stance).
 */
let dummyHashPromise: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(24).toString("hex"));
  }
  return dummyHashPromise;
}
