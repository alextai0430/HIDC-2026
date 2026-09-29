import {
  categories,
  executionLabels,
  type Competitor,
  type Profile,
  type Submission,
} from "./model";
import { canManage } from "./access";

export function ownSubmissions(profile: Profile, submissions: Submission[]) {
  return submissions.filter((s) => s.user_id === profile.id);
}

export function isPerformanceSubmission(submission: Submission) {
  return (submission.scoring_type ?? (submission.slot > 3 ? "performance" : "technical")) === "performance";
}

// Performance values are visible to their judge because those values are the
// judge's own ratings. Technical point values remain behind the Admin gate.
export function canViewOwnPerformancePoints(profile: Profile, submission: Submission) {
  return ["performance_judge", "organizer", "server_admin", "judge"].includes(profile.role) &&
    submission.user_id === profile.id && isPerformanceSubmission(submission);
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
  profiles: Profile[] = [],
) {
  return detailSubmissions(profile, submissions).map((s) => ({
    Competitor: competitors.find((c) => c.id === s.competitor_id)?.name,
    Judge: s.user_id === profile.id ? profile.name : profiles.find((candidate) => candidate.id === s.user_id)?.name ?? "Former judge",
    Scoring: s.scoring_type ?? (s.slot <= 3 ? "Technical" : "Performance"),
    Status: s.finished ? "Submitted" : "Draft",
    DQ: s.dq,
    Updated: s.updated_at,
    Events: JSON.stringify(
      s.events.map((e) => ({
        ...(revealPoints && e.value !== undefined ? e : {
          id: e.id,
          trick: e.trick,
          level: e.level,
          features: e.features,
          at: e.at,
        }),
        execution: executionLabels[e.execution ?? "E0"],
      })),
    ),
    ...(revealPoints || canViewOwnPerformancePoints(profile, s)
      ? { Total: s.total, Performance: s.performance.join(" / ") }
      : {}),
  }));
}

export function personalScoreExportRows(
  profile: Profile,
  submissions: Submission[],
  competitors: Competitor[],
  revealPoints = false,
) {
  return ownSubmissions(profile, submissions).map((s) => {
    const mayReveal = revealPoints || canViewOwnPerformancePoints(profile, s);
    const type = s.scoring_type ?? (s.slot <= 3 ? "technical" : "performance");
    return {
      Competitor: competitors.find((c) => c.id === s.competitor_id)?.name,
      Status: s.finished ? "Submitted" : "Draft",
      Total: mayReveal ? s.total ?? "—" : "***",
      ...(type === "technical"
        ? {
            Events: JSON.stringify(
              s.events.map((e) => ({
                trick: e.trick,
                level: e.level,
                features: e.features,
                execution: executionLabels[e.execution ?? "E0"],
                at: e.at,
                points: revealPoints ? e.value ?? "—" : "***",
              })),
            ),
          }
        : Object.fromEntries(categories.map((c, i) => [c, mayReveal ? s.performance[i] : "***"]))),
    };
  });
}
