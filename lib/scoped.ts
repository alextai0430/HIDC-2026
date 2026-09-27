import {
  categories,
  type Competitor,
  type Profile,
  type Submission,
} from "./model";
import { canManage } from "./access";

export function ownSubmissions(profile: Profile, submissions: Submission[]) {
  return submissions.filter((s) => s.user_id === profile.id);
}

export function detailSubmissions(profile: Profile, submissions: Submission[]) {
  return canManage(profile)
    ? submissions
    : ownSubmissions(profile, submissions);
}

export function detailExportRows(
  profile: Profile,
  submissions: Submission[],
  competitors: Competitor[],
  revealPoints = false,
) {
  const revealOwnPoints = revealPoints;
  return detailSubmissions(profile, submissions).map((s) => ({
    Competitor: competitors.find((c) => c.id === s.competitor_id)?.name,
    Judge: s.slot,
    Status: s.finished ? "Finished" : "Draft",
    DQ: s.dq,
    Updated: s.updated_at,
    Events: JSON.stringify(
      s.events.map((e) =>
        revealOwnPoints && e.value !== undefined
          ? { ...e, value: e.value }
          : { trick: e.trick, level: e.level, features: e.features, at: e.at },
      ),
    ),
    ...(revealOwnPoints
      ? { Total: s.total, Performance: s.performance.join(" / ") }
      : {}),
  }));
}

export function personalScoreExportRows(
  profile: Profile,
  submissions: Submission[],
  competitors: Competitor[],
) {
  return ownSubmissions(profile, submissions).map((s) => ({
    Competitor: competitors.find((c) => c.id === s.competitor_id)?.name,
    Status: s.finished ? "Finished" : "Draft",
    Total: s.total ?? "—",
    ...(s.slot < 4
      ? {
          Events: JSON.stringify(
            s.events.map((e) => ({
              trick: e.trick,
              points: e.value ?? "—",
            })),
          ),
        }
      : Object.fromEntries(categories.map((c, i) => [c, s.performance[i]]))),
  }));
}
