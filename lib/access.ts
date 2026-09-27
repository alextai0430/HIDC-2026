import type { Profile } from "./model";
// Explicit opt-in restores the competition's original permission boundaries.
export const adminProtectionEnabled =
  process.env.NEXT_PUBLIC_ADMIN_PROTECTION_ENABLED === "true";
export function canManage(
  profile: Profile,
  protection = adminProtectionEnabled,
) {
  return !protection || profile.role === "server_admin";
}
