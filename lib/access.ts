import type { Profile } from "./model";
export function isAdministrator(profile: Profile) {
  return (
    profile.active &&
    (profile.is_admin === true || profile.role === "organizer" || profile.role === "server_admin")
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
  return profile.active && !isAdministrator(profile);
}
export function isAssignedJudge(profile: Profile): boolean {
  return profile.active && ["technical_judge", "performance_judge", "organizer", "judge", "server_admin"].includes(profile.role);
}
export function profileCanScoreType(profile: Profile, scoringType: "technical" | "performance") {
  if (!profile.active) return false;
  if (profile.role === "organizer" || profile.role === "server_admin") return true;
  if (profile.role === "technical_judge") return scoringType === "technical";
  if (profile.role === "performance_judge") return scoringType === "performance";
  // Compatibility for old local snapshots only. Live profiles are migrated to explicit roles.
  if (profile.role === "judge") return scoringType === ((profile.slot ?? 1) <= 3 ? "technical" : "performance");
  return false;
}
export function scoringTabs(profile: Profile): ("Technical" | "Performance")[] {
  const tabs: ("Technical" | "Performance")[] = [];
  if (profileCanScoreType(profile, "technical")) tabs.push("Technical");
  if (profileCanScoreType(profile, "performance")) tabs.push("Performance");
  return tabs;
}
