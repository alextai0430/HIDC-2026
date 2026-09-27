import type { Profile } from "./model";
// Development access is deliberately independent of permanent account privileges.
export const adminProtectionEnabled =
  process.env.NEXT_PUBLIC_ADMIN_PROTECTION_ENABLED === "true";
export function isAdministrator(profile: Profile) {
  return profile.is_admin === true || profile.role === "server_admin";
}
export function canManage(
  profile: Profile,
  protection = adminProtectionEnabled,
) {
  return profile.active && (!protection || isAdministrator(profile));
}
export function canEditJudge(profile: Profile) {
  return profile.role === "judge" && !isAdministrator(profile);
}
export function isAssignedJudge(
  profile: Profile,
): profile is Profile & { role: "judge"; slot: number } {
  return (
    profile.active &&
    profile.role === "judge" &&
    Number.isInteger(profile.slot) &&
    profile.slot! >= 1 &&
    profile.slot! <= 5
  );
}
