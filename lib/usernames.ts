import { z } from "zod";
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9_-]{2,31}$/,
    "Use 3–32 letters, numbers, underscores or hyphens.",
  );
// Server-side callers only. This address is never a public account field.
export function internalAddress(username: string) {
  return `${usernameSchema.parse(username)}.${crypto.randomUUID()}@hidc.internal`;
}
