import type { Profile } from "./model";
export function isAdministrator(profile: Profile) {
  return (
    profile.active &&
    (profile.is_admin === true || profile.role === "server_admin")
  );
}
export function canManage(profile: Profile) {
  return isAdministrator(profile);
}
export function canManageScoringConfiguration(profile: Profile) {
  return (
    isAdministrator(profile) &&
    ["organizer", "alexandertai"].includes(profile.username?.toLowerCase() ?? "")
  );
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
